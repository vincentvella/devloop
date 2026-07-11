/**
 * Shared-mode plumbing (#round2.1) — let a per-session stdio launch *bridge* to a
 * long-running daemon instead of spawning its own browser. The stdio process becomes
 * a thin proxy: it speaks stdio to the MCP client (Claude Code) and forwards every
 * tools/list + tools/call to the daemon over HTTP. So many sessions share one browser,
 * one dev server, one timeline — the daemon (#22) story, made seamless.
 *
 * Opt-in only (--shared or DEVLOOP_DAEMON=1); the default per-session behavior in
 * src/index.ts is untouched. Bridging always falls back to local on any failure.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { clearDaemonState, type DaemonState, httpReachable, pidAlive, readDaemonState } from "./daemonState.ts";
import { VERSION } from "./version.ts";

const log = (m: string) => process.stderr.write(`[devloop] ${m}\n`);

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
  log("shared mode: no daemon found, starting one…");
  const spawnOpts: SpawnOptions = {
    detached: true, // outlive this session
    stdio: "ignore",
    env: process.env,
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
