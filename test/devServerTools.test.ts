import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTool } from "../src/toolLayer.ts";
import { configure, parse } from "./handleToolHarness.ts";

// Isolate the project registry (dev_start reads it for `project`).
let home: string;
const realHome = process.env.DEVLOOP_HOME;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "devloop-dev-"));
  process.env.DEVLOOP_HOME = home;
});
afterAll(() => {
  if (realHome === undefined) delete process.env.DEVLOOP_HOME;
  else process.env.DEVLOOP_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

test("dev_start with explicit cmd+cwd starts the server and returns its status", async () => {
  const { devServer } = configure();
  const r = parse(await handleTool("dev_start", { cmd: "bun run dev", cwd: "/proj" }));
  expect(r).toMatchObject({ running: true });
  expect(devServer.start).toHaveBeenCalledWith("bun run dev", "/proj");
});

test("dev_start with an unknown project name throws", async () => {
  configure();
  await expect(handleTool("dev_start", { project: "no-such-project-xyz" })).rejects.toThrow(/no saved project/i);
});

test("dev_stop returns {stopped}", async () => {
  const { devServer } = configure();
  expect(parse(await handleTool("dev_stop", {})).stopped).toBe(true);
  expect(devServer.stop).toHaveBeenCalled();
});

test("dev_status returns the server status", async () => {
  configure({ devServer: { start: async () => ({}), stop: () => false, status: () => ({ running: true, pid: 9 }) } });
  expect(parse(await handleTool("dev_status", {}))).toMatchObject({ running: true, pid: 9 });
});
