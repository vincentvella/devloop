import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { carriesToken, classifyOrigin, rendererCorsHeaders, ServeEmu } from "../cockpit/serveEmu.ts";
import { SCRCPY_VERSION, vendoredScrcpyVersion, vendoredServeEmuDir } from "../cockpit/stageServeEmu.ts";

const PREFIX = "serve-emu.token.";

test("carriesToken accepts the Bearer header or the WebSocket subprotocol, nothing else", () => {
  expect(carriesToken({ authorization: "Bearer t1" }, "t1", PREFIX)).toBe(true);
  expect(carriesToken({ "sec-websocket-protocol": "x, serve-emu.token.t1" }, "t1", PREFIX)).toBe(true);
  expect(carriesToken({ authorization: "Bearer nope" }, "t1", PREFIX)).toBe(false);
  expect(carriesToken({ "sec-websocket-protocol": "serve-emu.token.nope" }, "t1", PREFIX)).toBe(false);
  expect(carriesToken({}, "t1", PREFIX)).toBe(false);
});

test("classifyOrigin only lifts the origin check for a file:// page that has the token", () => {
  const tok = { authorization: "Bearer t1" };
  expect(classifyOrigin("GET", { origin: "null", ...tok }, "t1", PREFIX)).toBe("strip");
  expect(classifyOrigin("GET", { origin: "file://", ...tok }, "t1", PREFIX)).toBe("strip");
  expect(classifyOrigin("GET", { origin: "null" }, "t1", PREFIX)).toBe("reject");
  expect(classifyOrigin("POST", { origin: "null", authorization: "Bearer wrong" }, "t1", PREFIX)).toBe("reject");
  expect(classifyOrigin("OPTIONS", { origin: "null" }, "t1", PREFIX)).toBe("preflight");
  // Real http(s) origins, and non-browser clients, stay under serve-emu's own policy.
  expect(classifyOrigin("GET", { origin: "https://evil.example" }, "t1", PREFIX)).toBe("pass");
  expect(classifyOrigin("GET", {}, "t1", PREFIX)).toBe("pass");
});

test("rendererCorsHeaders echoes the renderer's origin and allows the token header", () => {
  const h = rendererCorsHeaders("null");
  expect(h["Access-Control-Allow-Origin"]).toBe("null");
  expect(h["Access-Control-Allow-Headers"]).toContain("Authorization");
});

test("the vendored serve-emu is where we load it from, and wants the scrcpy-server we pin", () => {
  // Guards an expo-device-hub upgrade: the path is unofficial and the server is checksum-pinned.
  const dir = vendoredServeEmuDir();
  expect(existsSync(join(dir, "dist", "middleware.js"))).toBe(true);
  expect(vendoredScrcpyVersion(dir)).toBe(SCRCPY_VERSION);
});

// --- the HTTP/WebSocket adapter, against a fake serve-emu module ---

let dir: string;
let emu: ServeEmu;
let base: string;
let token: string;

beforeAll(async () => {
  // Records what reached the "router" so we can assert the Origin was dropped.
  dir = mkdtempSync(join(tmpdir(), "devloop-emu-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(dir, "dist", "middleware.js"),
    `export const SESSION_TOKEN_SUBPROTOCOL_PREFIX = "serve-emu.token.";
     export function fromWsSocket(ws) { return ws; }
     export function createRouter({ sessionToken }) {
       return {
         async handleRequest(req) {
           const body = req.method === "POST" ? await req.text() : "";
           return Response.json({ path: new URL(req.url).pathname, origin: req.headers.get("origin"), body });
         },
         authorizeUpgrade: (req) => (req.headers.get("sec-websocket-protocol") ?? "").includes(sessionToken),
         ensure: async (device) => ({ serial: device ?? "emulator-5554" }),
         attachWebSocket(ws, opts) { ws.send(JSON.stringify({ serial: opts.serial, origin: opts.request.headers.get("origin") })); },
         stopAll: async () => {},
       };
     }`,
  );
  emu = new ServeEmu(() => {}, dir);
  ({ baseUrl: base, token } = await emu.ensure());
});
afterAll(async () => {
  await emu.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("ensure() starts one loopback server and reuses it", async () => {
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect((await emu.ensure()).baseUrl).toBe(base);
});

test("a file:// request with the token reaches serve-emu without its Origin, and gets CORS back", async () => {
  const res = await fetch(`${base}/api/tap?device=emulator-5554`, {
    method: "POST",
    headers: { origin: "null", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: '{"x":0.5,"y":0.5}',
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("null");
  expect(await res.json()).toEqual({ path: "/api/tap", origin: null, body: '{"x":0.5,"y":0.5}' });
});

test("a file:// request without the token never reaches serve-emu", async () => {
  const res = await fetch(`${base}/api/tap`, { method: "POST", headers: { origin: "null" }, body: "{}" });
  expect(res.status).toBe(403);
});

test("a token-less file:// preflight gets CORS headers only", async () => {
  const res = await fetch(`${base}/api/tap`, {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST" },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("null");
});

test("an http(s) origin is passed through untouched for serve-emu to judge", async () => {
  const res = await fetch(`${base}/api/devices`, { headers: { origin: "https://evil.example" } });
  expect((await res.json()).origin).toBe("https://evil.example");
});

const openSocket = (protocols: string[], origin = "null") =>
  new Promise<{ msg?: string; error?: string }>((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?device=emulator-5554`, protocols, { origin });
    ws.on("message", (m) => {
      resolve({ msg: String(m) });
      ws.close();
    });
    ws.on("error", (e) => resolve({ error: e.message }));
  });

test("the stream socket opens with the token subprotocol, Origin dropped", async () => {
  const { msg } = await openSocket([`serve-emu.token.${token}`]);
  expect(JSON.parse(msg!)).toEqual({ serial: "emulator-5554", origin: null });
});

test("the stream socket is refused without the token", async () => {
  const { msg, error } = await openSocket(["serve-emu.token.wrong"]);
  expect(msg).toBeUndefined(); // never attached to the device
  expect(error).toBeDefined();
});
