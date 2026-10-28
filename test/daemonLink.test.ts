import { expect, test } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type DaemonConn, DaemonExitedError, DaemonLink, neverReachedDaemon } from "../src/daemonClient.ts";
import type { DaemonState } from "../src/daemonState.ts";

const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const state = (pid: number): DaemonState => ({ pid, port: 1, url: `http://daemon-${pid}/mcp`, startedAt: "" });

/** A fake daemon connection whose callTool runs `impl`. */
function fakeConn(impl: (signal?: AbortSignal) => Promise<unknown>) {
  const conn = {
    calls: 0,
    dropped: false,
    ended: false,
    client: {
      listTools: async () => ({ tools: [] }),
      callTool: async (_p: unknown, _s?: unknown, o?: { signal?: AbortSignal }) => {
        conn.calls++;
        return impl(o?.signal) as never;
      },
    },
    end: async () => {
      conn.ended = true;
    },
    drop: async () => {
      conn.dropped = true;
    },
  };
  return conn satisfies DaemonConn;
}

const callVia = (link: DaemonLink) => link.call((c, signal) => c.callTool({ name: "x" }, undefined, { signal }));

test("neverReachedDaemon: refused connections and unknown sessions only", () => {
  expect(neverReachedDaemon(refused())).toBe(true); // Node fetch
  expect(neverReachedDaemon(Object.assign(new Error("x"), { code: "ConnectionRefused" }))).toBe(true); // Bun fetch
  expect(neverReachedDaemon(new StreamableHTTPError(400, "no valid session"))).toBe(true);
  expect(neverReachedDaemon(new StreamableHTTPError(404, "session not found"))).toBe(true);
  expect(neverReachedDaemon(new StreamableHTTPError(500, "boom"))).toBe(false);
  expect(neverReachedDaemon(new Error("MCP error -32602: Invalid params"))).toBe(false);
  expect(neverReachedDaemon(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(
    false,
  ); // dropped mid-request: it may have run
});

test("a call that never reached the daemon reconnects and is replayed once", async () => {
  const dead = fakeConn(async () => Promise.reject(refused()));
  const fresh = fakeConn(async () => "ok");
  let reconnects = 0;
  const link = new DaemonLink({
    findOrStart: async () => state(2),
    connect: async (url) => (url.includes("daemon-1") ? dead : fresh),
    alive: () => true,
    onReconnect: () => reconnects++,
  });
  await link.start(state(1));
  expect(await callVia(link)).toBe("ok");
  expect([dead.calls, fresh.calls, reconnects, dead.dropped]).toEqual([1, 1, 1, true]);
});

test("concurrent failing calls share one reconnect", async () => {
  const dead = fakeConn(async () => Promise.reject(new StreamableHTTPError(400, "no valid session")));
  const fresh = fakeConn(async () => "ok");
  let finds = 0;
  const link = new DaemonLink({
    findOrStart: async () => {
      finds++;
      return state(2);
    },
    connect: async (url) => (url.includes("daemon-1") ? dead : fresh),
    alive: () => true,
  });
  await link.start(state(1));
  expect(await Promise.all([callVia(link), callVia(link), callVia(link)])).toEqual(["ok", "ok", "ok"]);
  expect(finds).toBe(1);
});

test("a real error from the daemon is passed through, with no reconnect", async () => {
  const conn = fakeConn(async () => Promise.reject(new Error("MCP error -32602: Invalid params")));
  let finds = 0;
  const link = new DaemonLink({
    findOrStart: async () => {
      finds++;
      return state(2);
    },
    connect: async () => conn,
    alive: () => true,
  });
  await link.start(state(1));
  await expect(callVia(link)).rejects.toThrow(/Invalid params/);
  expect(finds).toBe(0);
});

test("a daemon exiting mid-call fails the call fast, is not replayed, and the next call reconnects", async () => {
  let up = true;
  // Hangs until aborted, like a request whose daemon died (the SDK would wait 60s).
  const hung = fakeConn(
    (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const fresh = fakeConn(async () => "ok");
  const link = new DaemonLink({
    findOrStart: async () => state(2),
    connect: async (url) => (url.includes("daemon-1") ? hung : fresh),
    alive: (pid) => pid !== 1 || up,
    pollMs: 5,
  });
  await link.start(state(1));
  const pending = callVia(link);
  setTimeout(() => (up = false), 20);
  await expect(pending).rejects.toBeInstanceOf(DaemonExitedError);
  expect(hung.calls).toBe(1); // not replayed
  expect(hung.dropped).toBe(true);
  expect(await callVia(link)).toBe("ok"); // next call reconnects
  expect(fresh.calls).toBe(1);
});

test("end() ends the session on the daemon", async () => {
  const conn = fakeConn(async () => "ok");
  const link = new DaemonLink({ findOrStart: async () => state(1), connect: async () => conn, alive: () => true });
  await link.start(state(1));
  await link.end();
  expect(conn.ended).toBe(true);
});
