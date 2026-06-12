import { test, expect } from "bun:test";
import { LogBuffer } from "../src/logBuffer.ts";

test("push assigns increasing seq and tracks latestSeq", () => {
  const b = new LogBuffer(100);
  const e1 = b.push("server", "stdout", "a");
  const e2 = b.push("browser", "console", "b");
  expect(e1.seq).toBe(0);
  expect(e2.seq).toBe(1);
  expect(b.latestSeq).toBe(1);
});

test("query filters by source / stream / grep / sinceSeq / limit / targets", () => {
  const b = new LogBuffer(100);
  b.push("server", "stdout", "hello world");
  b.push("browser", "console", "[error] boom", undefined, "pane-1");
  b.push("browser", "network", "404 GET /x", undefined, "pane-2");

  expect(b.query({ source: "server" }).length).toBe(1);
  expect(b.query({ stream: "network" }).length).toBe(1);
  expect(b.query({ grep: "boom" }).length).toBe(1);
  expect(b.query({ grep: "BOOM" }).length).toBe(1); // case-insensitive
  expect(b.query({ grep: "[error" }).length).toBe(1); // invalid regex → substring fallback
  expect(b.query({ targets: ["pane-1"] }).map((e) => e.line)).toEqual(["[error] boom"]);
  expect(b.query({ targets: ["pane-1", "pane-2"] }).length).toBe(2);
  const all = b.query();
  expect(b.query({ sinceSeq: all[all.length - 1]!.seq }).length).toBe(1);
  expect(b.query({ limit: 1 }).length).toBe(1);
});

test("ring buffer drops the oldest beyond capacity", () => {
  const b = new LogBuffer(3);
  for (let i = 0; i < 5; i++) b.push("server", "stdout", "l" + i);
  const q = b.query({ limit: 100 });
  expect(q.length).toBe(3);
  expect(q[0]!.line).toBe("l2");
  expect(q[2]!.line).toBe("l4");
});

test("around returns entries within the window, filtered by source/targets", () => {
  const b = new LogBuffer(100);
  b.push("server", "stdout", "x", undefined, "pane-1");
  b.push("browser", "console", "y", undefined, "pane-2");
  const ts = Date.now();
  expect(b.around(ts, 5000).length).toBe(2);
  expect(b.around(ts, 5000, "server").length).toBe(1);
  expect(b.around(ts, 5000, undefined, ["pane-2"]).length).toBe(1);
  expect(b.around(ts - 10_000_000, 10).length).toBe(0); // far outside window
});

test("onPush notifies live, unsubscribe stops it, clear empties", () => {
  const b = new LogBuffer(100);
  const seen: string[] = [];
  const off = b.onPush((e) => seen.push(e.line));
  b.push("server", "stdout", "a");
  off();
  b.push("server", "stdout", "b");
  expect(seen).toEqual(["a"]);
  b.clear();
  expect(b.query().length).toBe(0);
});
