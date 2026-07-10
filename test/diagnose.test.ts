import { expect, test } from "bun:test";
import { diagnose, staleNativeBuildNote } from "../src/diagnose.ts";
import type { LogEntry } from "../src/logBuffer.ts";

const e = (over: Partial<LogEntry>): LogEntry => ({
  seq: 0,
  ts: 1000,
  source: "browser",
  stream: "console",
  line: "",
  ...over,
});

test("#14: a missing native module flags a stale native build (and leads the summary)", () => {
  const r = diagnose([e({ stream: "pageerror", line: "Error: Cannot find native module 'ExpoCamera'", ts: 100 })]);
  expect(r.nativeNotes.length).toBe(1);
  expect(r.nativeNotes[0]).toContain("native build looks stale");
  expect(r.nativeNotes[0]).toContain("ExpoCamera");
  expect(r.summary.startsWith("native build looks stale")).toBe(true);
  // a plain error doesn't trip the rule
  expect(diagnose([e({ stream: "pageerror", line: "Error: boom" })]).nativeNotes).toEqual([]);
});

test("staleNativeBuildNote matches the known signatures, not unrelated errors", () => {
  const g = (sample: string) => [
    { source: "browser", stream: "pageerror", sample, count: 1, firstTs: 0, lastTs: 0, targets: [] },
  ];
  expect(staleNativeBuildNote(g("Cannot find native module 'X'"))).not.toBeNull();
  expect(
    staleNativeBuildNote(g("Your JavaScript code tried to access a native module that doesn't exist")),
  ).not.toBeNull();
  expect(staleNativeBuildNote(g("TypeError: undefined is not a function"))).toBeNull();
});

test("VEL-65: surfaces native (iOS simctl / Android logcat) crash lines, skips clean ones", () => {
  const r = diagnose([
    e({
      source: "native",
      stream: "log",
      line: "NSException *** -[__NSArrayM objectAtIndex:] index 3 beyond bounds",
      ts: 100,
    }),
    e({ source: "native", stream: "log", line: "E/AndroidRuntime: FATAL EXCEPTION: main", ts: 200 }),
    e({ source: "native", stream: "log", line: "I/ReactNativeJS: running application 'app'", ts: 300 }), // clean → skipped
  ]);
  expect(r.errorCount).toBe(2);
  expect(r.groups.map((g) => g.source)).toEqual(["native", "native"]);
  expect(r.groups.some((g) => /running application/.test(g.sample))).toBe(false);
});

test("VEL-65: a native stale-module line still triggers the rebuild hint", () => {
  const r = diagnose([e({ source: "native", stream: "log", line: "Error: Cannot find native module 'ExpoCamera'" })]);
  expect(r.nativeNotes[0]).toContain("native build looks stale");
});

test("groups repeated errors with counts and collects network failures", () => {
  const r = diagnose([
    e({ stream: "console", line: "[error] TypeError: x is undefined", ts: 100 }),
    e({ stream: "console", line: "[error] TypeError: x is undefined", ts: 200 }), // dup → grouped
    e({ stream: "console", line: "[log] hi" }), // not an error
    e({ stream: "pageerror", line: "Error: boom", ts: 300 }),
    e({
      stream: "network",
      line: "500 GET /api/x",
      detail: { kind: "network", url: "http://h/api/x", method: "GET", status: 500 },
      ts: 400,
    }),
    e({
      stream: "network",
      line: "500 GET /api/x",
      detail: { kind: "network", url: "http://h/api/x", method: "GET", status: 500 },
      ts: 450,
    }), // dup net
    e({ source: "server", stream: "stderr", line: "UnhandledPromiseRejection: nope", ts: 500 }),
    e({
      stream: "network",
      line: "200 GET /ok",
      detail: { kind: "network", url: "http://h/ok", method: "GET", status: 200 },
    }), // healthy
  ]);
  expect(r.errorCount).toBe(6); // 2 console + 1 page + 2 net + 1 server
  const typeErr = r.groups.find((g) => g.sample.includes("TypeError"));
  expect(typeErr?.count).toBe(2);
  expect(r.groups.some((g) => g.sample === "Error: boom")).toBe(true);
  expect(r.groups.some((g) => g.source === "server")).toBe(true);
  const failed = r.network.find((n) => n.url.includes("/api/x"));
  expect(failed?.count).toBe(2);
  expect(r.network.some((n) => n.url.includes("/ok"))).toBe(false); // 200 isn't a failure
  expect(r.summary).toMatch(/error/i);
});

test("windowMs keeps only recent entries", () => {
  const now = 10_000;
  const r = diagnose(
    [e({ stream: "pageerror", line: "old", ts: 1000 }), e({ stream: "pageerror", line: "recent", ts: 9_500 })],
    { windowMs: 1000, now },
  );
  expect(r.errorCount).toBe(1);
  expect(r.groups[0]!.sample).toBe("recent");
});

test("a clean run reports no errors", () => {
  const r = diagnose([e({ stream: "console", line: "[log] all good" })]);
  expect(r.errorCount).toBe(0);
  expect(r.groups).toEqual([]);
  expect(r.network).toEqual([]);
  expect(r.summary).toMatch(/no errors/i);
});
