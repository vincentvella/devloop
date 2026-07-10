import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon, findDaemon } from "../src/daemonClient.ts";

let dir: string;
const realHome = process.env.DEVLOOP_HOME;
const statePath = () => join(dir, "daemon.json");
const writeState = (s: Record<string, unknown>) => writeFileSync(statePath(), JSON.stringify(s));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devloop-dc-"));
  process.env.DEVLOOP_HOME = dir;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.DEVLOOP_HOME;
  else process.env.DEVLOOP_HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

/** A live HTTP endpoint that answers (any status counts as reachable). */
async function liveServer(): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://localhost:${port}/mcp`, close: () => server.close() };
}

/** A port with nothing listening (bind then immediately free it). */
async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://localhost:${port}/mcp`;
}

test("findDaemon → undefined when no state file exists", async () => {
  expect(await findDaemon()).toBeUndefined();
});

test("findDaemon clears the state file and returns undefined for a dead pid", async () => {
  const kill = spyOn(process, "kill").mockImplementation(() => {
    const e = new Error("ESRCH") as NodeJS.ErrnoException;
    e.code = "ESRCH";
    throw e;
  });
  writeState({ pid: 999999, port: 7333, url: "http://localhost:7333/mcp" });
  expect(await findDaemon()).toBeUndefined();
  expect(existsSync(statePath())).toBe(false); // stale state cleared
  kill.mockRestore();
});

test("findDaemon → undefined when the pid is alive but HTTP is unreachable (state kept)", async () => {
  writeState({ pid: process.pid, port: 7333, url: await deadUrl() });
  expect(await findDaemon()).toBeUndefined();
  expect(existsSync(statePath())).toBe(true); // up-but-not-answering: don't clear
});

test("findDaemon returns the state when the pid is alive and HTTP is reachable", async () => {
  const srv = await liveServer();
  try {
    const state = { pid: process.pid, port: 7333, url: srv.url };
    writeState(state);
    expect(await findDaemon()).toMatchObject(state);
  } finally {
    srv.close();
  }
});

test("ensureDaemon returns an already-running daemon without spawning", async () => {
  const srv = await liveServer();
  try {
    writeState({ pid: process.pid, port: 7333, url: srv.url });
    expect(await ensureDaemon(5000)).toMatchObject({ url: srv.url });
  } finally {
    srv.close();
  }
});

test("ensureDaemon throws on timeout when the daemon never comes up", async () => {
  // Point the daemon entry at a no-op script so the real spawn exits immediately and
  // never writes state — exercises the poll + timeout path without a real daemon.
  const noop = join(dir, "noop.js");
  writeFileSync(noop, "process.exit(0)\n");
  const realArgv1 = process.argv[1];
  process.argv[1] = noop;
  try {
    await expect(ensureDaemon(150)).rejects.toThrow(/did not come up/i);
  } finally {
    process.argv[1] = realArgv1;
  }
});
