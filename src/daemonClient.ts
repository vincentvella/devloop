/**
 * Shared-mode plumbing (#round2.1) — let a per-session stdio launch *bridge* to a
 * long-running daemon instead of spawning its own browser. The stdio process becomes
 * a thin proxy: it speaks stdio to the MCP client (Claude Code) and forwards every
 * tools/list + tools/call to the daemon over HTTP. So many sessions share one browser,
 * one dev server, one timeline — the daemon (#22) story, made seamless.
 *
 * The default since 0.11: each stdio launch bridges to a per-project daemon (keyed by
 * its cwd), so restarting a session reuses the same Chrome instead of opening another.
 * `--shared` / DEVLOOP_DAEMON=1 picks one global daemon; `--local` / DEVLOOP_DAEMON=0
 * keeps the old one-browser-per-session behavior. Bridging always falls back to local
 * on any failure.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  clearDaemonState,
  type DaemonState,
  daemonScope,
  httpReachable,
  pidAlive,
  readDaemonState,
} from "./daemonState.ts";
import { VERSION } from "./version.ts";

const log = (m: string) => process.stderr.write(`[devloop] ${m}\n`);

/** How a stdio launch runs: its own browser, or bridged to a daemon (`scope` undefined = global). */
export type LaunchMode = { kind: "local" } | { kind: "shared"; scope?: string };

export function launchMode(args: string[], env: Record<string, string | undefined>, cwd: string): LaunchMode {
  if (args.includes("--local") || env.DEVLOOP_DAEMON === "0") return { kind: "local" };
  const explicit = env.DEVLOOP_DAEMON_SCOPE ? resolve(env.DEVLOOP_DAEMON_SCOPE) : undefined;
  if (args.includes("--shared") || env.DEVLOOP_DAEMON === "1") return { kind: "shared", scope: explicit };
  return { kind: "shared", scope: explicit ?? resolve(env.DEVLOOP_DEV_CWD || cwd) };
}

/** Idle exit for an auto-spawned daemon, so Chrome closes once every session is gone. */
export const AUTO_DAEMON_IDLE_MS = 10 * 60_000;

/** Env for an auto-spawned daemon: keep stdio's visible-by-default browser (the daemon
 *  itself defaults headless) and give it an idle exit unless one was configured. */
export function daemonSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    DEVLOOP_HEADLESS: env.DEVLOOP_HEADLESS === "true" ? "true" : "false",
    DEVLOOP_DAEMON_IDLE_MS: env.DEVLOOP_DAEMON_IDLE_MS || String(AUTO_DAEMON_IDLE_MS),
  };
}

/** Find a live daemon via the state file, clearing it if the process is dead/unreachable. */
export async function findDaemon(): Promise<DaemonState | undefined> {
  const s = readDaemonState();
  if (!s) return undefined;
  if (!pidAlive(s.pid)) {
    clearDaemonState();
    return undefined;
  }
  if (!(await httpReachable(s.url))) return undefined; // up but not answering — treat as absent
  return s;
}

/** Spawn a detached daemon and wait until its state file is live. Throws on timeout. */
export async function ensureDaemon(timeoutMs = 20_000): Promise<DaemonState> {
  const existing = await findDaemon();
  if (existing) return existing;

  const self = process.argv[1];
  if (!self) throw new Error("cannot resolve the devloop entry script to spawn a daemon");
  const scope = daemonScope();
  log(`shared mode: no daemon found${scope ? ` for ${scope}` : ""}, starting one…`);
  const spawnOpts: SpawnOptions = {
    detached: true, // outlive this session
    stdio: "ignore",
    env: daemonSpawnEnv(process.env),
    cwd: scope, // a scoped daemon's dev_start defaults to its project
  };
  const child = spawn(process.execPath, [self, "daemon"], spawnOpts);
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await findDaemon();
    if (s) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`daemon did not come up within ${timeoutMs}ms`);
}

/**
 * Run this process as a stdio→HTTP proxy to the daemon at `url`. Returns once wired;
 * the process then lives until the stdio client disconnects (then it closes its daemon
 * session — graceful per-client teardown — and exits, leaving the daemon running).
 */
/** The proxy's tools/list + tools/call handlers, forwarding to the daemon `client`.
 *  Extracted so the forwarding (incl. the arguments-default) is unit-testable without a
 *  live stdio/HTTP round-trip — the bridge itself needs real transports. */
export function daemonProxyHandlers(client: Pick<Client, "listTools" | "callTool">) {
  return {
    listTools: () => client.listTools(),
    callTool: (req: { params: { name: string; arguments?: unknown } }) =>
      client.callTool({ name: req.params.name, arguments: (req.params.arguments ?? {}) as Record<string, unknown> }),
  };
}

export async function bridgeStdioToDaemon(url: string): Promise<void> {
  const client = new Client({ name: "devloop-bridge", version: VERSION }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const proxy = new Server({ name: "devloop-mcp", version: VERSION }, { capabilities: { tools: {} } });
  const h = daemonProxyHandlers(client);
  proxy.setRequestHandler(ListToolsRequestSchema, h.listTools);
  proxy.setRequestHandler(CallToolRequestSchema, (req) => h.callTool(req));

  let closing = false;
  const teardown = async () => {
    if (closing) return;
    closing = true;
    await client.close().catch(() => {}); // DELETE the session on the daemon
    process.exit(0);
  };
  // The MCP client disconnecting closes our stdin; mirror that into a clean teardown.
  process.stdin.on("end", teardown);
  process.stdin.on("close", teardown);
  process.on("SIGINT", teardown);
  process.on("SIGTERM", teardown);

  await proxy.connect(new StdioServerTransport());
  log(`shared mode: bridged to daemon at ${url}`);
}
