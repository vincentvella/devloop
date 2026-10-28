/**
 * Android screen streaming via Expo's serve-emu — the Android parallel to serve-sim.
 * serve-emu runs scrcpy on the device and streams H.264 (with real touch, swipe, text
 * and key input) to `@expo/hub-client`'s DeviceScreen in the renderer. It replaces the
 * old `adb screencap` PNG poller (~3fps) and `adb shell input` taps.
 *
 * serve-emu's Node build only ships vendored inside `expo-device-hub`; cockpit/build.ts
 * stages it into out/serve-emu (with its deps and a checksum-pinned scrcpy-server) and
 * electron-builder leaves that unpacked, so adb can push the server from a real path.
 * We host its router in-process on a loopback port, as the Hub's own server does.
 *
 * Security: the router runs with a random per-session token that only our renderer
 * learns (over IPC), so other local pages can't drive the device. The renderer is a
 * file:// page, which sends `Origin: null` — serve-emu (rightly) rejects that, and any
 * sandboxed iframe on any website can send it too. So we only lift the origin check for
 * a request that ALSO carries the token: its Origin is dropped (serve-emu then treats it
 * as the trusted non-browser client it already allows) and the response gets CORS for
 * `null`. Token-less `null` preflights get headers only; they can't reach the device.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

/** What the renderer needs to connect `@expo/hub-client` to a device. */
export interface EmuEndpoint {
  baseUrl: string;
  token: string;
}

/** The slice of serve-emu's middleware module we use. */
interface EmuRouter {
  handleRequest(req: Request): Promise<Response>;
  authorizeUpgrade(req: Request): boolean;
  ensure(device: string | null): Promise<{ serial: string }>;
  attachWebSocket(
    socket: unknown,
    opts: { serial: string; video: boolean; frameMeta: boolean; request: Request },
  ): void;
  stopAll(): Promise<void>;
}
interface EmuModule {
  createRouter(opts: { sessionToken?: string }): EmuRouter;
  fromWsSocket(ws: unknown): unknown;
  SESSION_TOKEN_SUBPROTOCOL_PREFIX: string;
}

type Headers_ = Record<string, string | string[] | undefined>;

/** Origins a file:// renderer page sends. */
const FILE_ORIGINS = new Set(["null", "file://"]);
const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_HEADERS = "Authorization, Content-Type";

/** Does this request carry the session token (Bearer header, or the WebSocket subprotocol)? */
export function carriesToken(headers: Headers_, token: string, subprotocolPrefix: string): boolean {
  if (headers.authorization === `Bearer ${token}`) return true;
  const protocols = String(headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
  return protocols.includes(`${subprotocolPrefix}${token}`);
}

/**
 * How to treat a request's Origin: `pass` leaves it to serve-emu's own policy; `strip`
 * is our file:// renderer with the token (drop Origin, answer with CORS for it);
 * `preflight` is a token-less file:// CORS preflight (headers only); `reject` is a
 * file:// request without the token.
 */
export function classifyOrigin(
  method: string,
  headers: Headers_,
  token: string,
  subprotocolPrefix: string,
): "pass" | "strip" | "preflight" | "reject" {
  const origin = headers.origin;
  if (typeof origin !== "string" || !FILE_ORIGINS.has(origin)) return "pass";
  if (carriesToken(headers, token, subprotocolPrefix)) return "strip";
  return method === "OPTIONS" ? "preflight" : "reject";
}

/** CORS response headers for our file:// renderer. */
export function rendererCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** A Node request → a fetch Request (Origin dropped when `stripOrigin`). */
export function toWebRequest(req: IncomingMessage, base: string, stripOrigin: boolean, withBody: boolean): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || (stripOrigin && k === "origin")) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const body = withBody && req.method !== "GET" && req.method !== "HEAD" ? Readable.toWeb(req) : undefined;
  return new Request(new URL(req.url ?? "/", base), {
    method: req.method,
    headers,
    body: body as ReadableStream | undefined,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

export class ServeEmu {
  private server?: Server;
  private wss?: WebSocketServer;
  private router?: EmuRouter;
  private endpoint?: EmuEndpoint;
  private starting?: Promise<EmuEndpoint>;

  constructor(
    private readonly log: (m: string) => void,
    /** Directory holding the staged serve-emu (out/serve-emu, unpacked when packaged). */
    private readonly dir: string,
  ) {}

  /** Path to the staged serve-emu middleware, or null if the build didn't stage it. */
  entry(): string | null {
    const p = join(this.dir, "dist", "middleware.js");
    return existsSync(p) ? p : null;
  }

  /** Start the loopback server + router (once per Android session) and return its endpoint. */
  ensure(): Promise<EmuEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<EmuEndpoint> {
    const entry = this.entry();
    if (!entry) throw new Error(`serve-emu is not staged at ${this.dir} (run \`bun run app:build\`)`);
    const emu = (await import(pathToFileURL(entry).href)) as EmuModule;
    const token = randomBytes(24).toString("base64url"); // letters, digits, - and _ only
    const router = emu.createRouter({ sessionToken: token });
    const prefix = emu.SESSION_TOKEN_SUBPROTOCOL_PREFIX;
    let base = "http://127.0.0.1";

    const server = createServer((req, res) => void this.handle(req, res, router, base, token, prefix));
    const wss = new WebSocketServer({ noServer: true }); // echoes the first offered subprotocol
    server.on("upgrade", (req, socket, head) => {
      const kind = classifyOrigin("GET", req.headers, token, prefix);
      const request = toWebRequest(req, base, kind === "strip", false);
      if (kind === "reject" || !router.authorizeUpgrade(request)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const url = new URL(request.url);
        const video = url.searchParams.get("video") !== "0"; // mirrors the Hub's ws options
        router
          .ensure(url.searchParams.get("device"))
          .then(({ serial }) =>
            router.attachWebSocket(emu.fromWsSocket(ws), {
              serial,
              video,
              frameMeta: video && url.searchParams.get("frame-meta") === "1",
              request,
            }),
          )
          .catch((e) => {
            this.log(`serve-emu: no device for the stream (${(e as Error).message})`);
            ws.close();
          });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    this.server = server;
    this.wss = wss;
    this.router = router;
    this.endpoint = { baseUrl: base, token };
    this.log(`serve-emu: streaming server on ${base}`);
    return this.endpoint;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    router: EmuRouter,
    base: string,
    token: string,
    prefix: string,
  ): Promise<void> {
    const origin = String(req.headers.origin ?? "");
    const kind = classifyOrigin(req.method ?? "GET", req.headers, token, prefix);
    if (kind === "preflight") {
      res.writeHead(204, rendererCorsHeaders(origin)).end();
      return;
    }
    if (kind === "reject") {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
      return;
    }
    try {
      const out = await router.handleRequest(toWebRequest(req, base, kind === "strip", true));
      const headers: Record<string, string> = Object.fromEntries(out.headers);
      if (kind === "strip") Object.assign(headers, rendererCorsHeaders(origin));
      res.writeHead(out.status, headers);
      if (out.body) Readable.fromWeb(out.body as never).pipe(res);
      else res.end();
    } catch (e) {
      this.log(`serve-emu: ${req.method} ${req.url} failed (${(e as Error).message})`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end();
    }
  }

  /** Stop streaming (scrcpy on the device included) and close the server. The next ensure() starts fresh. */
  async stop(): Promise<void> {
    const { router, server, wss } = this;
    this.router = this.server = this.wss = this.endpoint = undefined;
    await router?.stopAll().catch((e) => this.log(`serve-emu: stop failed (${(e as Error).message})`));
    for (const ws of wss?.clients ?? []) ws.terminate();
    wss?.close();
    server?.closeAllConnections();
    server?.close();
  }
}
