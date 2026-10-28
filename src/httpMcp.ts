/**
 * Streamable-HTTP MCP transport — the shared server behind both the Electron cockpit
 * and the headless daemon (#22). Each connecting client gets its own MCP session
 * (transport), but they all drive the SAME configured tool layer (one browser, one
 * timeline) — which is the point of the daemon: many agents, one Devloop instance.
 *
 * Pure transport plumbing; the backend (browser/devServer) is wired separately via
 * configureTools before this is started.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Read + JSON-parse the request body. Rejects on a stream `error` (a dropped/reset
 * socket otherwise leaves the Promise — and the handler + `res` — hung forever) or
 * if the body exceeds `MAX` (a runaway body would otherwise accumulate in memory and
 * could OOM the shared daemon). Malformed JSON resolves to `undefined` (the caller
 * treats that as "no valid session"). Exported for unit testing.
 */
export function readBody(req: IncomingMessage): Promise<unknown> {
  const MAX = 4 * 1024 * 1024; // 4 MB
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Closes sessions whose client has gone away without a DELETE (killed, crashed, or an
 * SDK client that only `close()`d). An MCP client holds a GET SSE stream open for its
 * session's lifetime and reconnects it within seconds if it drops, so a session with no
 * open stream for `graceMs` is dead. Sessions that never opened a stream are left alone.
 */
export class StreamReaper {
  private readonly open = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly graceMs: number,
    private readonly expire: (sessionId: string) => void,
  ) {}

  opened(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.open.set(id, (this.open.get(id) ?? 0) + 1);
  }

  closed(id: string): void {
    const was = this.open.get(id);
    if (was === undefined) return; // already forgotten (its stream closes after a DELETE)
    const n = was - 1;
    this.open.set(id, n);
    if (n > 0 || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.forget(id);
      this.expire(id);
    }, this.graceMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** The session ended on its own (DELETE, or expired): drop its bookkeeping. */
  forget(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.open.delete(id);
  }
}

export interface HttpMcp {
  server: HttpServer;
  /** The port actually bound (may differ from the requested one if it was taken). */
  port: number;
}

/**
 * Start an HTTP MCP server on `/mcp`. `buildServer` is called once per client session.
 * Binds `port`, or the next free port within `tries` (so a stray instance never wedges
 * startup). Resolves once listening.
 */
export async function startHttpMcp(opts: {
  buildServer: () => Server;
  port: number;
  tries?: number;
  /**
   * Interface to bind. Defaults to `127.0.0.1` (loopback only) so the MCP endpoint —
   * and the browser/server/native data flowing over it — is never reachable from the
   * local network. Set to `0.0.0.0` only to deliberately expose a shared daemon.
   */
  host?: string;
  log?: (m: string) => void;
  /** Called with the live session count whenever a session opens or closes (for idle-shutdown). */
  onSessionsChanged?: (count: number) => void;
  /** How long a session may go without its GET stream before it's closed as dead (default 30s). */
  streamGraceMs?: number;
}): Promise<HttpMcp> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const reaper = new StreamReaper(opts.streamGraceMs ?? 30_000, (id) => {
    opts.log?.(`session ${id.slice(0, 8)} lost its client; closing it`);
    void transports.get(id)?.close();
  });

  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.setHeader("Access-Control-Allow-Origin", "*"); // so cross-origin probes get the response
      res.setHeader("Content-Type", "text/html; charset=utf-8"); // an HTML doc so content scripts inject
      return res.end("<!doctype html><title>404</title>not found");
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        // Stream error or oversized body — answer instead of leaking the response.
        res.statusCode = 400;
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.end(JSON.stringify({ error: "invalid or oversized request body" }));
      }
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
            opts.onSessionsChanged?.(transports.size);
          },
        });
        transport.onclose = () => {
          const id = transport!.sessionId;
          if (!id || !transports.delete(id)) return; // already closed (DELETE, then reaped)
          reaper.forget(id);
          opts.onSessionsChanged?.(transports.size);
        };
        await opts.buildServer().connect(transport);
      }
      if (!transport) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "no valid session" }));
      }
      return transport.handleRequest(req, res, body);
    }

    // GET (SSE stream) / DELETE (close) reuse an existing session
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.statusCode = 400;
      return res.end("invalid session");
    }
    if (req.method === "GET" && sid) {
      reaper.opened(sid);
      res.once("close", () => reaper.closed(sid));
    }
    return transport.handleRequest(req, res);
  });

  const host = opts.host ?? "127.0.0.1";
  const port = await listenOnFreePort(server, opts.port, host, opts.tries ?? 10, opts.log);
  opts.log?.(`MCP over HTTP listening on http://${host}:${port}/mcp`);
  return { server, port };
}

/** Try one port: true once listening, false if it's taken. Leaves no listeners behind. */
function tryListen(server: HttpServer, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, host);
  });
}

/**
 * Bind `port`, else the next free one within `tries`, else any free port the OS picks.
 * Returns the port actually bound. Every caller advertises this port (the daemon's state
 * file, the cockpit's MCP URL), so it must never be one that another process holds.
 */
export async function listenOnFreePort(
  server: HttpServer,
  port: number,
  host: string,
  tries: number,
  log?: (m: string) => void,
): Promise<number> {
  const bound = () => (server.address() as AddressInfo).port; // real port, also when asked for 0
  for (let p = port; p < port + tries; p++) if (await tryListen(server, p, host)) return bound();
  log?.(`ports ${port}–${port + tries - 1} are all in use; binding a free port instead`);
  await tryListen(server, 0, host);
  return bound();
}
