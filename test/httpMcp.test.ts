import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { listenOnFreePort, readBody, StreamReaper } from "../src/httpMcp.ts";

/** A minimal IncomingMessage stand-in: emit data/end/error, track destroy(). */
function mockReq(): { req: IncomingMessage; destroyed: () => boolean } {
  let destroyed = false;
  const e = new EventEmitter() as EventEmitter & { destroy: () => void };
  e.destroy = () => {
    destroyed = true;
  };
  return { req: e as unknown as IncomingMessage, destroyed: () => destroyed };
}

test("readBody parses a valid JSON body", async () => {
  const { req } = mockReq();
  const p = readBody(req);
  req.emit("data", '{"jsonrpc":"2.0","id":1}');
  req.emit("end");
  expect(await p).toEqual({ jsonrpc: "2.0", id: 1 });
});

test("readBody resolves undefined on malformed JSON (no throw)", async () => {
  const { req } = mockReq();
  const p = readBody(req);
  req.emit("data", "not json{");
  req.emit("end");
  expect(await p).toBeUndefined();
});

test("readBody rejects when the request stream errors — no more hanging forever", async () => {
  const { req } = mockReq();
  const p = readBody(req);
  req.emit("error", new Error("socket hang up"));
  await expect(p).rejects.toThrow(/socket hang up/);
});

test("readBody rejects and destroys the request when the body exceeds the 4MB cap", async () => {
  const { req, destroyed } = mockReq();
  const p = readBody(req);
  req.emit("data", "x".repeat(4 * 1024 * 1024 + 1));
  await expect(p).rejects.toThrow(/too large/i);
  expect(destroyed()).toBe(true);
});

/** Hold `n` consecutive free loopback ports; returns the first and a closer. */
async function holdPorts(n: number): Promise<{ first: number; close: () => void }> {
  for (;;) {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const first = (probe.address() as AddressInfo).port;
    const held: Server[] = [probe];
    for (let p = first + 1; p < first + n; p++) {
      const s = createServer();
      const ok = await new Promise<boolean>((r) => {
        s.once("error", () => r(false));
        s.listen(p, "127.0.0.1", () => r(true));
      });
      if (!ok) break;
      held.push(s);
    }
    const close = () => {
      for (const s of held) s.close();
    };
    if (held.length === n) return { first, close };
    close(); // a neighbour was taken; try another range
  }
}

test("listenOnFreePort skips taken ports and reports the one it bound", async () => {
  const held = await holdPorts(2);
  const server = createServer();
  try {
    const port = await listenOnFreePort(server, held.first, "127.0.0.1", 5);
    expect(port).toBe(held.first + 2);
    expect((server.address() as AddressInfo).port).toBe(port);
  } finally {
    server.close();
    held.close();
  }
});

test("listenOnFreePort binds an OS-chosen port when the whole range is taken, never a taken one", async () => {
  const held = await holdPorts(3);
  const server = createServer();
  const logs: string[] = [];
  try {
    const port = await listenOnFreePort(server, held.first, "127.0.0.1", 3, (m) => logs.push(m));
    expect(port >= held.first && port < held.first + 3).toBe(false);
    expect((server.address() as AddressInfo).port).toBe(port);
    expect(logs.join()).toMatch(/all in use/);
  } finally {
    server.close();
    held.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("StreamReaper expires a session once its stream has been gone for the grace period", async () => {
  const expired: string[] = [];
  const r = new StreamReaper(20, (id) => expired.push(id));
  r.opened("a");
  r.closed("a");
  expect(expired).toEqual([]); // not yet: the client may be reconnecting
  await sleep(40);
  expect(expired).toEqual(["a"]);
});

test("StreamReaper keeps a session whose client reconnects within the grace period", async () => {
  const expired: string[] = [];
  const r = new StreamReaper(30, (id) => expired.push(id));
  r.opened("a");
  r.closed("a");
  await sleep(10);
  r.opened("a"); // the SDK client's SSE reconnect
  await sleep(50);
  expect(expired).toEqual([]);
});

test("StreamReaper waits for the last of several streams, and forget() cancels", async () => {
  const expired: string[] = [];
  const r = new StreamReaper(20, (id) => expired.push(id));
  r.opened("a");
  r.opened("a");
  r.closed("a");
  await sleep(40);
  expect(expired).toEqual([]); // one stream still open
  r.closed("a");
  r.forget("a"); // e.g. the client DELETEd its session meanwhile
  r.opened("b");
  r.closed("b");
  r.opened("c");
  r.forget("c"); // DELETEd: its stream closes afterwards, which must not expire it again
  r.closed("c");
  await sleep(40);
  expect(expired).toEqual(["b"]);
});
