import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonProxyHandlers, daemonSpawnEnv, ensureDaemon, findDaemon, launchMode } from "../src/daemonClient.ts";

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

test("concurrent ensureDaemon calls spawn exactly one daemon", async () => {
  // A fake daemon: counts its own launches, advertises a live URL, then stays up briefly.
  const srv = await liveServer();
  const counter = join(dir, "spawns");
  const fake = join(dir, "fake-daemon.js");
  writeFileSync(
    fake,
    `const fs = require("node:fs");
     fs.appendFileSync(${JSON.stringify(counter)}, "x");
     fs.writeFileSync(${JSON.stringify(statePath())}, JSON.stringify({ pid: process.pid, port: 1, url: ${JSON.stringify(srv.url)} }));
     setTimeout(() => {}, 3000);`,
  );
  const realArgv1 = process.argv[1];
  process.argv[1] = fake;
  try {
    const states = await Promise.all([ensureDaemon(5000), ensureDaemon(5000), ensureDaemon(5000)]);
    expect(readFileSync(counter, "utf8")).toBe("x"); // one spawn, not three
    expect(new Set(states.map((s) => s.pid)).size).toBe(1);
    process.kill(states[0]!.pid, "SIGTERM");
  } finally {
    process.argv[1] = realArgv1;
    srv.close();
  }
});

test("daemonProxyHandlers forwards tools/list + tools/call to the daemon client", async () => {
  const calls: unknown[] = [];
  const client = {
    listTools: async () => ({ tools: [{ name: "browser_navigate" }] }),
    callTool: async (args: unknown) => {
      calls.push(args);
      return { content: [] };
    },
  };
  const h = daemonProxyHandlers(client as unknown as Parameters<typeof daemonProxyHandlers>[0]);

  expect(await h.listTools()).toEqual({ tools: [{ name: "browser_navigate" }] });

  await h.callTool({ params: { name: "diagnose", arguments: { app: "x" } } });
  expect(calls[0]).toEqual({ name: "diagnose", arguments: { app: "x" } });

  // Missing arguments must default to {} (the daemon's tool layer expects an object).
  await h.callTool({ params: { name: "dev_status" } });
  expect(calls[1]).toEqual({ name: "dev_status", arguments: {} });
});

test("launchMode defaults to a daemon scoped to the session's project", () => {
  expect(launchMode([], {}, "/work/app")).toEqual({ kind: "shared", scope: "/work/app" });
  expect(launchMode([], { DEVLOOP_DEV_CWD: "/work/other" }, "/work/app")).toEqual({
    kind: "shared",
    scope: "/work/other",
  });
  expect(launchMode([], { DEVLOOP_DAEMON_SCOPE: "/pinned" }, "/work/app")).toEqual({
    kind: "shared",
    scope: "/pinned",
  });
});

test("launchMode: --shared / DEVLOOP_DAEMON=1 → global daemon; --local / DEVLOOP_DAEMON=0 → local", () => {
  expect(launchMode(["--shared"], {}, "/work/app")).toEqual({ kind: "shared", scope: undefined });
  expect(launchMode([], { DEVLOOP_DAEMON: "1" }, "/work/app")).toEqual({ kind: "shared", scope: undefined });
  expect(launchMode(["--local"], {}, "/work/app")).toEqual({ kind: "local" });
  expect(launchMode([], { DEVLOOP_DAEMON: "0" }, "/work/app")).toEqual({ kind: "local" });
});

test("daemonSpawnEnv keeps stdio's visible browser and adds an idle exit unless configured", () => {
  expect(daemonSpawnEnv({})).toMatchObject({ DEVLOOP_HEADLESS: "false", DEVLOOP_DAEMON_IDLE_MS: "600000" });
  expect(daemonSpawnEnv({ DEVLOOP_HEADLESS: "true", DEVLOOP_DAEMON_IDLE_MS: "5000" })).toMatchObject({
    DEVLOOP_HEADLESS: "true",
    DEVLOOP_DAEMON_IDLE_MS: "5000",
  });
});
