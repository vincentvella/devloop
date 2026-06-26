/**
 * Integration test for shared-mode stdio → daemon auto-connect (#round2.1).
 *
 * Proves: a `--shared` stdio launch with no daemon running auto-spawns one and
 * bridges to it; a second `--shared` launch reuses the SAME daemon (one pid); and
 * `daemon --status` / `daemon --stop` work. Run: `bun run scripts/test-daemon-autoconnect.ts`
 * (headless; needs the dist build — runs `bun run mcp:build` first).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok]);
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "dist", "index.cjs");
const HOME = mkdtempSync(join(tmpdir(), "devloop-autoconnect-"));
const PORT = "7361"; // off the default 7333 so we never touch a real daemon
const ENV = { ...process.env, DEVLOOP_HOME: HOME, DEVLOOP_HTTP_PORT: PORT, DEVLOOP_HEADLESS: "true" };

const stateFile = join(HOME, "daemon.json");
const readPid = (): number | undefined => {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")).pid;
  } catch {
    return undefined;
  }
};

async function sharedClient(name: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: "node", args: [ENTRY, "--shared"], env: ENV });
  const client = new Client({ name, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  // Fresh build so dist reflects the source under test.
  spawnSync("bun", ["run", "mcp:build"], { cwd: ROOT, stdio: "inherit" });

  // 1) First --shared session: no daemon yet → it should spawn + bridge.
  const a = await sharedClient("a");
  const toolsA = await a.listTools();
  check("shared client A connects + lists tools", toolsA.tools.length > 0, `${toolsA.tools.length} tools`);
  check("a daemon state file was written", existsSync(stateFile));
  const pid1 = readPid();
  check(
    "state file has a live daemon pid",
    !!pid1 &&
      (() => {
        try {
          process.kill(pid1!, 0);
          return true;
        } catch {
          return false;
        }
      })(),
  );

  // a non-browser tool works through the bridge (reads the shared log buffer)
  const logs = await a.callTool({ name: "get_logs", arguments: {} });
  check("tools/call routes through the bridge to the daemon", !logs.isError, "get_logs");

  // 2) Second --shared session: must REUSE the same daemon (same pid, no 2nd spawn).
  const b = await sharedClient("b");
  const toolsB = await b.listTools();
  check("shared client B connects", toolsB.tools.length > 0);
  const pid2 = readPid();
  check("B reused the SAME daemon (one instance)", !!pid2 && pid2 === pid1, `pid ${pid1} == ${pid2}`);

  // 3) daemon --status reports running.
  const status = execFileSync("node", [ENTRY, "daemon", "--status"], { env: ENV, encoding: "utf8" });
  check("daemon --status reports running", /running/.test(status), status.trim());

  // Close bridges (leaves the daemon up).
  await a.close().catch(() => {});
  await b.close().catch(() => {});

  // 4) daemon --stop stops it; --status then reports not running.
  const stop = execFileSync("node", [ENTRY, "daemon", "--stop"], { env: ENV, encoding: "utf8" });
  check("daemon --stop stops it", /stopped/.test(stop), stop.trim());
  await new Promise((r) => setTimeout(r, 800));
  const status2 = execFileSync("node", [ENTRY, "daemon", "--status"], { env: ENV, encoding: "utf8" });
  check("daemon --status reports not running after stop", /not running/.test(status2), status2.trim());

  const failed = checks.filter(([, ok]) => !ok).length;
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
