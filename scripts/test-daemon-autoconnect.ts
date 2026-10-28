/**
 * Integration test for shared-mode stdio → daemon auto-connect (#round2.1).
 *
 * Proves: a `--shared` stdio launch with no daemon running auto-spawns one and
 * bridges to it; a second `--shared` launch reuses the SAME daemon (one pid); and
 * `daemon --status` / `daemon --stop` work. Then the default (no flag): two launches in a
 * project dir share ONE per-project daemon, separate from the global one; and a daemon
 * exits once its last session ends. Run: `bun run scripts/test-daemon-autoconnect.ts`
 * (headless; needs the dist build — runs `bun run mcp:build` first).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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

async function sharedClient(name: string, args = ["--shared"], cwd?: string, env = ENV): Promise<Client> {
  const transport = new StdioClientTransport({ command: "node", args: [ENTRY, ...args], env, cwd });
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

  // 5) Default (no flag): sessions in a project dir share that project's daemon.
  const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), "devloop-project-"))); // cwd is always the real path
  const scopedPid = (): number | undefined => {
    const d = join(HOME, "daemons");
    const files = existsSync(d) ? readdirSync(d) : [];
    return files.length === 1 ? JSON.parse(readFileSync(join(d, files[0]!), "utf8")).pid : undefined;
  };
  const c = await sharedClient("c", [], PROJECT);
  check("default launch connects + lists tools", (await c.listTools()).tools.length > 0);
  const pidC = scopedPid();
  check("default launch wrote a per-project daemon state", !!pidC);
  check("global daemon slot stays empty", !existsSync(stateFile));
  await c.close().catch(() => {});
  const d = await sharedClient("d", [], PROJECT);
  await d.listTools();
  check("a restarted session reuses the project's daemon", !!pidC && scopedPid() === pidC, `pid ${pidC}`);
  await d.close().catch(() => {});
  const run = (a: string[]) => execFileSync("node", [ENTRY, ...a], { env: ENV, cwd: PROJECT, encoding: "utf8" });
  const status3 = run(["daemon", "--status"]);
  check("daemon --status in the project finds its daemon", status3.includes(`for ${PROJECT}`), status3.trim());
  check("daemon --stop in the project stops it", /stopped/.test(run(["daemon", "--stop"])));

  // 6) Concurrent launches in a fresh project must start ONE daemon, not one each.
  const RACE = realpathSync(mkdtempSync(join(tmpdir(), "devloop-race-")));
  const racers = await Promise.all(["r1", "r2", "r3"].map((n) => sharedClient(n, [], RACE)));
  const daemons = execFileSync("pgrep", ["-f", `${ENTRY} daemon`], { encoding: "utf8" })
    .trim()
    .split("\n");
  check("3 simultaneous launches started exactly one daemon", daemons.length === 1, `${daemons.length} daemon(s)`);
  await Promise.all(racers.map((r) => r.close().catch(() => {})));
  execFileSync("node", [ENTRY, "daemon", "--stop"], { env: ENV, cwd: RACE });

  // 7) An auto-spawned daemon exits once its last session ends (here a 2s idle limit).
  const IDLE_HOME = mkdtempSync(join(tmpdir(), "devloop-idle-"));
  const IDLE_ENV = { ...ENV, DEVLOOP_HOME: IDLE_HOME, DEVLOOP_HTTP_PORT: "7365", DEVLOOP_DAEMON_IDLE_MS: "2000" };
  const IDLE = realpathSync(mkdtempSync(join(tmpdir(), "devloop-idle-project-")));
  const e = await sharedClient("e", [], IDLE, IDLE_ENV);
  await e.listTools();
  const idleFiles = readdirSync(join(IDLE_HOME, "daemons")).filter((f) => f.endsWith(".json"));
  const idlePid: number | undefined = idleFiles[0]
    ? JSON.parse(readFileSync(join(IDLE_HOME, "daemons", idleFiles[0]), "utf8")).pid
    : undefined;
  await e.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));
  const idleAlive = (() => {
    try {
      process.kill(idlePid!, 0);
      return true;
    } catch {
      return false;
    }
  })();
  check("the daemon exits after its last session ends", !!idlePid && !idleAlive, `pid ${idlePid}`);
  if (idleAlive) process.kill(idlePid!, "SIGTERM");

  const failed = checks.filter(([, ok]) => !ok).length;
  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
