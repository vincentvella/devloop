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
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  acquireSpawnLock,
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

/**
 * Find this scope's daemon, spawning a detached one if none is running, and wait until
 * its state file is live. Concurrent launches race for a spawn lock: the winner spawns,
 * the rest wait for its daemon (or take over the lock if the winner dies). Throws on timeout.
 */
export async function ensureDaemon(timeoutMs = 20_000): Promise<DaemonState> {
  const self = process.argv[1];
  const scope = daemonScope();
  const deadline = Date.now() + timeoutMs;
  let release: (() => void) | undefined;
  let waitLogged = false;
  try {
    while (Date.now() < deadline) {
      const s = await findDaemon();
      if (s) return s;
      if (!release) {
        release = acquireSpawnLock(timeoutMs);
        if (release) {
          // The previous holder may have finished between our probe and taking the lock.
          const raced = await findDaemon();
          if (raced) return raced;
          if (!self) throw new Error("cannot resolve the devloop entry script to spawn a daemon");
          log(`shared mode: no daemon found${scope ? ` for ${scope}` : ""}, starting one…`);
          const spawnOpts: SpawnOptions = {
            detached: true, // outlive this session
            stdio: "ignore",
            env: daemonSpawnEnv(process.env),
            cwd: scope, // a scoped daemon's dev_start defaults to its project
          };
          spawn(process.execPath, [self, "daemon"], spawnOpts).unref();
        } else if (!waitLogged) {
          waitLogged = true;
          log("shared mode: another session is starting the daemon, waiting…");
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    release?.();
  }
  throw new Error(`daemon did not come up within ${timeoutMs}ms`);
}

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

/**
 * Did this call fail before reaching a daemon? True when the daemon isn't listening
 * (it exited) or doesn't know our session (it restarted, or reaped us as stale). Then
 * nothing ran, so the call is safe to replay on a fresh connection.
 */
export function neverReachedDaemon(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 400 || err.code === 404;
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++)
    if (e.code === "ECONNREFUSED" || e.code === "ConnectionRefused") return true; // Node / Bun fetch
  return false;
}

/** The daemon exited while a call was in flight: it may or may not have run. */
export class DaemonExitedError extends Error {
  constructor() {
    super(
      "The devloop daemon exited during this call, so it may or may not have run. Retry it: the next call reconnects.",
    );
  }
}

/** One live connection to a daemon. */
export interface DaemonConn {
  client: Pick<Client, "listTools" | "callTool">;
  /** End the session on the daemon (DELETE), then close. */
  end(): Promise<void>;
  /** Close locally only (the daemon is gone). */
  drop(): Promise<void>;
}

/**
 * The bridge's link to its daemon, which survives the daemon going away. A call that
 * never reached the daemon reconnects (finding or starting one, as at launch) and is
 * replayed once. A daemon that exits mid-call fails that call at once, instead of
 * after the SDK's 60s request timeout, and isn't replayed: it may have half-run (a click,
 * a navigation), so the agent decides. Its next call reconnects.
 */
export class DaemonLink {
  private conn?: DaemonConn;
  private state?: DaemonState;
  private connecting?: Promise<DaemonConn>;

  constructor(
    private readonly deps: {
      /** Find this scope's daemon, starting one if needed (ensureDaemon). */
      findOrStart: () => Promise<DaemonState>;
      connect: (url: string) => Promise<DaemonConn>;
      alive?: (pid: number) => boolean;
      /** How often to check the daemon is still alive while a call is in flight. */
      pollMs?: number;
      /** After a reconnect: the new daemon may be a different version, with other tools. */
      onReconnect?: () => void;
      log?: (m: string) => void;
    },
  ) {}

  /** Connect to an already-found daemon (the launch path). */
  async start(state: DaemonState): Promise<void> {
    this.conn = await this.deps.connect(state.url);
    this.state = state;
  }

  async call<T>(fn: (client: DaemonConn["client"], signal: AbortSignal) => Promise<T>): Promise<T> {
    const conn = await this.current();
    try {
      return await this.watched(conn, fn);
    } catch (err) {
      if (!neverReachedDaemon(err)) throw err;
      this.deps.log?.("daemon connection lost; reconnecting…");
      return this.watched(await this.reconnect(conn), fn); // replay once
    }
  }

  /** End our session on the daemon (bridge exit). */
  async end(): Promise<void> {
    await this.conn?.end().catch(() => {});
  }

  private current(): Promise<DaemonConn> {
    return this.conn ? Promise.resolve(this.conn) : this.reconnect(undefined);
  }

  /** Replace `stale` with a fresh connection; concurrent callers share one attempt. */
  private reconnect(stale: DaemonConn | undefined): Promise<DaemonConn> {
    if (this.conn && this.conn !== stale) return Promise.resolve(this.conn); // someone beat us to it
    this.connecting ??= (async () => {
      this.conn = undefined;
      await stale?.drop().catch(() => {});
      const state = await this.deps.findOrStart();
      const conn = await this.deps.connect(state.url);
      this.conn = conn;
      this.state = state;
      this.deps.log?.(`reconnected to daemon at ${state.url}`);
      this.deps.onReconnect?.();
      return conn;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Run `fn`, aborting it if the daemon's process exits meanwhile. */
  private async watched<T>(
    conn: DaemonConn,
    fn: (client: DaemonConn["client"], signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ctl = new AbortController();
    const pid = this.state?.pid;
    const alive = this.deps.alive ?? pidAlive;
    const timer =
      pid === undefined
        ? undefined
        : setInterval(() => {
            if (!alive(pid)) ctl.abort();
          }, this.deps.pollMs ?? 500);
    try {
      return await fn(conn.client, ctl.signal);
    } catch (err) {
      if (!ctl.signal.aborted) throw err;
      if (this.conn === conn) this.conn = undefined; // the next call reconnects
      await conn.drop().catch(() => {});
      throw new DaemonExitedError();
    } finally {
      clearInterval(timer);
    }
  }
}

/** Open an MCP client session to the daemon at `url`. */
async function connectToDaemon(url: string): Promise<DaemonConn> {
  const client = new Client({ name: "devloop-bridge", version: VERSION }, { capabilities: {} });
  client.onerror = () => {}; // the SSE stream erroring when a daemon exits; calls report it
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return {
    client,
    // End our session on the daemon (DELETE) so it can idle out. close() alone doesn't.
    end: async () => {
      await transport.terminateSession().catch(() => {});
      await client.close();
    },
    drop: () => client.close(),
  };
}

/**
 * Run this process as a stdio→HTTP proxy to the daemon in `state`. Returns once wired;
 * the process then lives until the stdio client disconnects (then it closes its daemon
 * session — graceful per-client teardown — and exits, leaving the daemon running). If
 * the daemon goes away meanwhile, the link reconnects (see DaemonLink).
 */
export async function bridgeStdioToDaemon(state: DaemonState): Promise<void> {
  const proxy = new Server(
    { name: "devloop-mcp", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  const link = new DaemonLink({
    findOrStart: () => ensureDaemon(),
    connect: connectToDaemon,
    onReconnect: () => void proxy.sendToolListChanged().catch(() => {}),
    log: (m) => log(`shared mode: ${m}`),
  });
  await link.start(state);

  const h = daemonProxyHandlers({
    listTools: () => link.call((c) => c.listTools()),
    callTool: (params) =>
      link
        .call((c, signal) => c.callTool(params, undefined, { signal }))
        // A tool result the agent reads, not a protocol error: it should decide on a retry.
        .catch((err) => {
          if (!(err instanceof DaemonExitedError)) throw err;
          return { isError: true, content: [{ type: "text" as const, text: err.message }] };
        }),
  });
  proxy.setRequestHandler(ListToolsRequestSchema, h.listTools);
  proxy.setRequestHandler(CallToolRequestSchema, (req) => h.callTool(req));

  let closing = false;
  const teardown = async () => {
    if (closing) return;
    closing = true;
    await link.end();
    process.exit(0);
  };
  // The MCP client disconnecting closes our stdin; mirror that into a clean teardown.
  process.stdin.on("end", teardown);
  process.stdin.on("close", teardown);
  process.on("SIGINT", teardown);
  process.on("SIGTERM", teardown);

  await proxy.connect(new StdioServerTransport());
  log(`shared mode: bridged to daemon at ${state.url}`);
}
