import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpReachable, pidAlive, readDaemonState } from "../src/daemonState.ts";

describe("pidAlive", () => {
  test("alive when the signal-0 probe succeeds (self)", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("dead when ESRCH (no such process)", () => {
    const spy = spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("ESRCH") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    });
    expect(pidAlive(123456)).toBe(false);
    spy.mockRestore();
  });

  test("alive when EPERM (exists but not signalable by us)", () => {
    const spy = spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("EPERM") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    });
    expect(pidAlive(1)).toBe(true);
    spy.mockRestore();
  });
});

describe("readDaemonState", () => {
  let dir: string;
  const realHome = process.env.DEVLOOP_HOME;
  const writeState = (s: string) => writeFileSync(join(dir, "daemon.json"), s);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devloop-ds-"));
    process.env.DEVLOOP_HOME = dir;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.DEVLOOP_HOME;
    else process.env.DEVLOOP_HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file → undefined", () => {
    expect(readDaemonState()).toBeUndefined();
  });

  test("malformed JSON → undefined", () => {
    writeState("{ not valid json");
    expect(readDaemonState()).toBeUndefined();
  });

  test("partial state (missing url) → undefined", () => {
    writeState(JSON.stringify({ pid: 1, port: 7333 }));
    expect(readDaemonState()).toBeUndefined();
  });

  test("wrong field types → undefined", () => {
    writeState(JSON.stringify({ pid: "1", port: 7333, url: "http://x" }));
    expect(readDaemonState()).toBeUndefined();
  });

  test("valid state → parsed object", () => {
    const s = { pid: 42, port: 7333, url: "http://localhost:7333/mcp", startedAt: "2026-01-01T00:00:00Z" };
    writeState(JSON.stringify(s));
    expect(readDaemonState()).toEqual(s);
  });
});

describe("httpReachable", () => {
  test("true when the endpoint answers (any status)", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404; // even an error status means it's listening
      res.end("nope");
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await httpReachable(`http://localhost:${port}/mcp`)).toBe(true);
    } finally {
      server.close();
    }
  });

  test("false on connection error (nothing listening)", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r())); // free the port
    expect(await httpReachable(`http://localhost:${port}/`, 500)).toBe(false);
  });

  test("false on timeout (accepts but never responds)", async () => {
    const sockets: Socket[] = [];
    const server = createServer(() => {
      /* deliberately never respond */
    });
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await httpReachable(`http://localhost:${port}/`, 100)).toBe(false);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });
});
