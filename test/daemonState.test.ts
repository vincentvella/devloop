import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSpawnLock,
  daemonStateFile,
  httpReachable,
  pidAlive,
  readDaemonState,
  writeDaemonState,
} from "../src/daemonState.ts";

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

  test("a scoped daemon gets its own state file, distinct per project", () => {
    const a = daemonStateFile("/work/a");
    expect(a).not.toBe(daemonStateFile("/work/b"));
    expect(a).not.toBe(daemonStateFile(undefined));
    expect(a.startsWith(join(dir, "daemons"))).toBe(true);
  });

  test("DEVLOOP_DAEMON_SCOPE routes read/write to the project's file, not the global one", () => {
    const s = { pid: 7, port: 7334, url: "http://127.0.0.1:7334/mcp", startedAt: "x", scope: "/work/a" };
    process.env.DEVLOOP_DAEMON_SCOPE = "/work/a";
    try {
      writeDaemonState(s);
      expect(readDaemonState()).toEqual(s);
    } finally {
      delete process.env.DEVLOOP_DAEMON_SCOPE;
    }
    expect(readDaemonState()).toBeUndefined(); // global slot untouched
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

describe("acquireSpawnLock", () => {
  let dir: string;
  const realHome = process.env.DEVLOOP_HOME;
  const lockFile = () => `${daemonStateFile()}.lock`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devloop-lock-"));
    process.env.DEVLOOP_HOME = dir;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.DEVLOOP_HOME;
    else process.env.DEVLOOP_HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("exclusive while held; free again once released", () => {
    const release = acquireSpawnLock(60_000);
    expect(release).toBeDefined();
    expect(acquireSpawnLock(60_000)).toBeUndefined(); // held by a live pid (us)
    release?.();
    expect(existsSync(lockFile())).toBe(false);
    const again = acquireSpawnLock(60_000);
    expect(again).toBeDefined();
    again?.();
  });

  test("breaks a lock whose holder is dead", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: 999999 }));
    const kill = spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("ESRCH") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    });
    const release = acquireSpawnLock(60_000);
    kill.mockRestore();
    expect(release).toBeDefined();
    release?.();
  });

  test("breaks a lock older than staleMs even if the holder looks alive", () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockFile(), old, old);
    const release = acquireSpawnLock(60_000);
    expect(release).toBeDefined();
    release?.();
  });

  test("an unreadable (mid-write) fresh lock is respected", () => {
    writeFileSync(lockFile(), "");
    expect(acquireSpawnLock(60_000)).toBeUndefined();
  });
});
