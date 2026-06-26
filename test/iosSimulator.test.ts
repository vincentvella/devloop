import { expect, test } from "bun:test";
import {
  logStreamArgs,
  NativeLogStream,
  nativeErrorLevel,
  parseLogLine,
  type SpawnLike,
  screenshotArgs,
} from "../src/iosSimulator.ts";
import { LogBuffer } from "../src/logBuffer.ts";

test("parseLogLine: compact line → level + process + message", () => {
  const r = parseLogLine("2026-06-12 21:09:00.123-0700 Df Caliburr[461:1a2b] hello from native");
  expect(r).toEqual({
    ts: "2026-06-12 21:09:00.123-0700",
    level: "log",
    process: "Caliburr",
    message: "hello from native",
  });
});

test("parseLogLine maps type codes to levels", () => {
  expect(parseLogLine("2026-06-12 21:09:00.1-0700 Er App[1:2] boom")?.level).toBe("error");
  expect(parseLogLine("2026-06-12 21:09:00.1-0700 Ft App[1:2] crash")?.level).toBe("fault");
  expect(parseLogLine("2026-06-12 21:09:00.1-0700 In App[1:2] fyi")?.level).toBe("info");
  expect(parseLogLine("2026-06-12 21:09:00.1-0700 Dg App[1:2] trace")?.level).toBe("debug");
});

test("parseLogLine drops noise/headers, keeps unrecognized lines as plain log", () => {
  expect(parseLogLine("")).toBeNull();
  expect(parseLogLine('Filtering the log data using "processImagePath CONTAINS \\"Caliburr\\""')).toBeNull();
  // an unrecognized but real line is kept rather than dropped
  expect(parseLogLine("some unstructured output")).toEqual({ level: "log", message: "some unstructured output" });
});

test("logStreamArgs scopes to the app process via predicate", () => {
  const args = logStreamArgs({ device: "BOOTED-ID", match: "Caliburr" });
  expect(args.slice(0, 6)).toEqual(["simctl", "spawn", "BOOTED-ID", "log", "stream", "--style"]);
  const pi = args.indexOf("--predicate");
  expect(pi).toBeGreaterThan(0);
  expect(args[pi + 1]).toBe('processImagePath CONTAINS "Caliburr"');
});

test("logStreamArgs omits predicate when unscoped, adds level when given", () => {
  expect(logStreamArgs({ device: "D" })).not.toContain("--predicate");
  expect(logStreamArgs({ device: "D", level: "debug" })).toContain("debug");
});

test("screenshotArgs builds the io screenshot command", () => {
  expect(screenshotArgs("D", "/tmp/x.png")).toEqual(["simctl", "io", "D", "screenshot", "/tmp/x.png"]);
});

test("nativeErrorLevel flags error + fault", () => {
  expect(nativeErrorLevel("error")).toBe(true);
  expect(nativeErrorLevel("fault")).toBe(true);
  expect(nativeErrorLevel("log")).toBe(false);
});

test("NativeLogStream parses spawned stdout into native buffer entries (chunked)", () => {
  const buffer = new LogBuffer(100);
  let onData: (chunk: string) => void = () => {};
  const fakeSpawn: SpawnLike = () => ({ stdout: { on: (_e, cb) => (onData = cb) }, kill: () => {} });

  const stream = new NativeLogStream(buffer, { device: "D", match: "Caliburr", spawn: fakeSpawn });
  stream.start();

  // split across chunks to exercise line buffering
  onData("2026-06-12 21:09:00.1-0700 Df Caliburr[1:2] first line\n2026-06-12 21:09:00.2-0700 Er Calibu");
  onData("rr[1:2] bad thing\n");

  const entries = buffer.query({ source: "native" });
  expect(entries.length).toBe(2);
  expect(entries[0]).toMatchObject({ source: "native", stream: "log", line: "first line" });
  expect(entries[1]).toMatchObject({ source: "native", stream: "error", line: "bad thing" });
  expect((entries[1]!.detail as any).process).toBe("Caliburr");
});
