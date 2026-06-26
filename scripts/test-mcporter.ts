/**
 * mcporter toolcall smoke (#4) — drive the daemon through the *real CLI path* that
 * sandboxed / enterprise agents use: `mcporter call devloop.<tool> …` over HTTP.
 *
 * This is the GUI-free assertion of the tool contract at the CLI layer — a
 * complement to the SDK-level scripts/test-daemon.ts and the Electron selftest.
 * It proves a vanilla MCP CLI (not our own SDK code) can discover and invoke the
 * tools against a running daemon, and that error/gating envelopes surface cleanly.
 *
 * Needs: a built dist/index.cjs + Chrome (the smoke CI job installs it) + network
 * on first run (fetches the pinned mcporter via bunx; cached afterwards).
 *
 *   bun run scripts/test-mcporter.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the CLI: a smoke test shouldn't break on an upstream mcporter release.
const MCPORTER = "mcporter@0.12.1";
const PORT = 7397;
const URL_ = `http://localhost:${PORT}/mcp`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails.push(name);
};

// A throwaway mcporter config registering the daemon as the "devloop" server, so
// calls use the canonical `devloop.<tool>` selector an agent would configure.
const dir = mkdtempSync(join(tmpdir(), "devloop-mcporter-"));
const cfg = join(dir, "mcporter.json");
writeFileSync(cfg, JSON.stringify({ mcpServers: { devloop: { type: "http", url: URL_ } } }));

interface CallResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
  isError: boolean;
}

/** Run `mcporter --config <cfg> <args…>` and parse the first JSON value from stdout. */
function mcporter(args: string[]): CallResult {
  const r = spawnSync("bunx", [MCPORTER, "--config", cfg, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = r.stdout ?? "";
  let json: any;
  const at = stdout.search(/[[{]/);
  if (at >= 0) {
    try {
      json = JSON.parse(stdout.slice(at));
    } catch {
      // leave json undefined; callers fall back to raw-string assertions
    }
  }
  // mcporter exits 0 even for tool-level failures; the MCP error envelope is the signal.
  const isError = json?.isError === true || /\bisError"?\s*:\s*true\b/.test(stdout);
  return { code: r.status, stdout, stderr: r.stderr ?? "", json, isError };
}

const daemon = spawn("node", ["dist/index.cjs", "daemon"], {
  env: { ...process.env, DEVLOOP_HTTP_PORT: String(PORT), DEVLOOP_HEADLESS: "true" },
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  // Wait for the daemon's HTTP endpoint to accept connections.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(URL_);
      up = true;
    } catch {
      await sleep(500);
    }
  }
  check("daemon serves MCP over HTTP", up);
  if (!up) throw new Error("daemon never came up");

  // 1. Tool discovery through the CLI — the contract is introspectable via `list`.
  const list = mcporter(["list", "devloop", "--json"]);
  const tools: { name: string }[] = list.json?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  check(
    "mcporter list discovers the tool layer over HTTP",
    tools.length >= 40 && names.has("browser_navigate") && names.has("get_network"),
    `${tools.length} tools`,
  );

  // 2. A read-only tool call returns its structured result (not an error).
  const status = mcporter(["call", "devloop.dev_status", "--output", "json"]);
  check(
    "mcporter call devloop.dev_status returns a structured result",
    !status.isError && typeof status.json?.running === "boolean",
    JSON.stringify(status.json ?? status.stdout.slice(0, 60)),
  );

  // 3. End-to-end through the CLI: navigate, then read it back off the timeline.
  const marker = "mcporter-smoke-marker";
  const nav = mcporter([
    "call",
    "devloop.browser_navigate",
    `url=data:text/html,<script>console.log('${marker}')</script>`,
    "--output",
    "json",
  ]);
  check("mcporter call devloop.browser_navigate succeeds (status 200)", !nav.isError && nav.json?.status === 200);
  await sleep(900);
  const logs = mcporter(["call", "devloop.get_logs", `grep=${marker}`, "limit:20", "--output", "json"]);
  check("the navigation is visible via mcporter call devloop.get_logs", logs.stdout.includes(marker));

  // 4. Error contract: an unknown tool surfaces an MCP error envelope (not a crash).
  const unknown = mcporter(["call", "devloop.not_a_real_tool", "--output", "json"]);
  check(
    "an unknown tool returns isError with a clear message",
    unknown.isError && /unknown tool/i.test(unknown.stdout),
  );

  // 5. Cockpit-only gating is surfaced over the CLI (daemon has no panes).
  const gated = mcporter(["call", "devloop.pane_set_label", "id=x", "label=y", "--output", "json"]);
  check("a cockpit-only tool reports cockpit-required over the CLI", gated.isError && /cockpit/i.test(gated.stdout));
} finally {
  daemon.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  fails.length ? `\nMCPORTER FAIL (${fails.length}): ${fails.join(", ")}` : "\nMCPORTER OK (all checks passed)",
);
process.exit(fails.length ? 1 : 0);
