import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { readBody } from "../src/httpMcp.ts";

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
