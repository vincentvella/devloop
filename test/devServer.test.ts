import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DevServer, detectDevCommand, projectName } from "../src/devServer.ts";
import { LogBuffer } from "../src/logBuffer.ts";

const pkgDir = (pkg: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "dl-dev-"));
  writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
  return d;
};

test("detectDevCommand picks by priority dev>develop>web>start>serve", () => {
  expect(detectDevCommand(pkgDir({ scripts: { start: "x", dev: "y" } }))).toBe("bun run dev");
  expect(detectDevCommand(pkgDir({ scripts: { serve: "x", web: "y" } }))).toBe("bun run web");
  expect(detectDevCommand(pkgDir({ scripts: { start: "x" } }))).toBe("bun run start");
});

test("detectDevCommand throws with no package.json or no dev-ish script", () => {
  expect(() => detectDevCommand(mkdtempSync(join(tmpdir(), "dl-empty-")))).toThrow(/no package\.json/);
  expect(() => detectDevCommand(pkgDir({ scripts: { build: "x" } }))).toThrow(/no dev script/);
});

test("detectDevCommand prefers all-target `start` over web-only `web` for Expo apps", () => {
  // Expo: `web` is expo start --web (web-only) and breaks native — prefer `start`.
  const expo = { dependencies: { expo: "^52.0.0" }, scripts: { web: "expo start --web", start: "expo start" } };
  expect(detectDevCommand(pkgDir(expo))).toBe("bun run start");
  // Non-Expo keeps web-first.
  expect(detectDevCommand(pkgDir({ scripts: { web: "vite", start: "node ." } }))).toBe("bun run web");
  // Expo with no start/dev script → canonical all-target Metro.
  expect(detectDevCommand(pkgDir({ dependencies: { expo: "^52.0.0" }, scripts: { build: "x" } }))).toBe(
    "bunx expo start",
  );
});

test("projectName uses package.json name, else folder basename", () => {
  expect(projectName(pkgDir({ name: "my-app" }))).toBe("my-app");
  const d = mkdtempSync(join(tmpdir(), "dl-noname-"));
  expect(projectName(d)).toBe(basename(d));
});

// --- DevServer class lifecycle (VEL-35) + the partial-line flush fix (VEL-34) ---

const TMP = tmpdir();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}
const hasLine = (b: LogBuffer, needle: string) => b.query({ limit: 1000 }).some((e) => e.line.includes(needle));

test("start() → status running with a pid; stop() tears it down", async () => {
  const dev = new DevServer(new LogBuffer(50));
  expect(dev.start("sleep 2", TMP).running).toBe(true);
  expect(typeof dev.status().pid).toBe("number");
  expect(dev.stop()).toBe(true);
  expect(await until(() => !dev.status().running)).toBe(true);
});

test("stop() on an already-stopped server returns false", () => {
  expect(new DevServer(new LogBuffer(10)).stop()).toBe(false);
});

test("stdout + stderr lines land in the buffer as server logs", async () => {
  const b = new LogBuffer(200);
  new DevServer(b).start("printf 'out-line\\n'; printf 'err-line\\n' 1>&2", TMP);
  expect(await until(() => hasLine(b, "out-line") && hasLine(b, "err-line"))).toBe(true);
  expect(b.query({ source: "server", limit: 1000 }).length).toBeGreaterThan(0);
});

test("a non-zero exit is exposed as exitCode in status()", async () => {
  const dev = new DevServer(new LogBuffer(50));
  dev.start("exit 3", TMP);
  await until(() => !dev.status().running);
  expect(dev.status().exitCode).toBe(3);
});

test("calling start() twice throws", () => {
  const dev = new DevServer(new LogBuffer(10));
  dev.start("sleep 2", TMP);
  try {
    expect(() => dev.start("sleep 2", TMP)).toThrow(/already running/i);
  } finally {
    dev.stop();
  }
});

test("VEL-34: the final partial line (no trailing newline) is flushed on stream end", async () => {
  const b = new LogBuffer(50);
  new DevServer(b).start("printf 'crash-no-newline'", TMP); // no trailing \n
  expect(await until(() => hasLine(b, "crash-no-newline"))).toBe(true);
});
