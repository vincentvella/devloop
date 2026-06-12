import { test, expect } from "bun:test";
import { diagnose } from "../src/diagnose.ts";
import type { LogEntry } from "../src/logBuffer.ts";

const e = (over: Partial<LogEntry>): LogEntry => ({ seq: 0, ts: 1000, source: "browser", stream: "console", line: "", ...over });

test("groups repeated errors with counts and collects network failures", () => {
  const r = diagnose([
    e({ stream: "console", line: "[error] TypeError: x is undefined", ts: 100 }),
    e({ stream: "console", line: "[error] TypeError: x is undefined", ts: 200 }), // dup → grouped
    e({ stream: "console", line: "[log] hi" }), // not an error
    e({ stream: "pageerror", line: "Error: boom", ts: 300 }),
    e({ stream: "network", line: "500 GET /api/x", detail: { kind: "network", url: "http://h/api/x", method: "GET", status: 500 }, ts: 400 }),
    e({ stream: "network", line: "500 GET /api/x", detail: { kind: "network", url: "http://h/api/x", method: "GET", status: 500 }, ts: 450 }), // dup net
    e({ source: "server", stream: "stderr", line: "UnhandledPromiseRejection: nope", ts: 500 }),
    e({ stream: "network", line: "200 GET /ok", detail: { kind: "network", url: "http://h/ok", method: "GET", status: 200 } }), // healthy
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
  const r = diagnose([e({ stream: "pageerror", line: "old", ts: 1000 }), e({ stream: "pageerror", line: "recent", ts: 9_500 })], { windowMs: 1000, now });
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
