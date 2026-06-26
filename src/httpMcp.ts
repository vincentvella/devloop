/**
 * Streamable-HTTP MCP transport — the shared server behind both the Electron cockpit
 * and the headless daemon (#22). Each connecting client gets its own MCP session
 * (transport), but they all drive the SAME configured tool layer (one browser, one
 * timeline) — which is the point of the daemon: many agents, one Devloop instance.
 *
 * Pure transport plumbing; the backend (browser/devServer) is wired separately via
 * configureTools before this is started.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
  });
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
  log?: (m: string) => void;
  /** Called with the live session count whenever a session opens or closes (for idle-shutdown). */
  onSessionsChanged?: (count: number) => void;
}): Promise<HttpMcp> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.setHeader("Access-Control-Allow-Origin", "*"); // so cross-origin probes get the response
      res.setHeader("Content-Type", "text/html; charset=utf-8"); // an HTML doc so content scripts inject
      return res.end("<!doctype html><title>404</title>not found");
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
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
          if (transport!.sessionId) transports.delete(transport!.sessionId);
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
    return transport.handleRequest(req, res);
  });

  let chosen = opts.port;
  const tries = opts.tries ?? 10;
  for (let p = opts.port; p < opts.port + tries; p++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onErr = (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err));
      server.once("error", onErr);
      server.listen(p, () => {
        server.removeListener("error", onErr);
        chosen = p;
        resolve(true);
      });
    });
    if (bound) break;
  }
  opts.log?.(`MCP over HTTP listening on http://localhost:${chosen}/mcp`);
  return { server, port: chosen };
}
