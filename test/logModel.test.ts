import { expect, test } from "bun:test";
import { buildDisplayRows, type LogRowInput, parseOsLog } from "../src/logModel.ts";

const e = (o: Partial<LogRowInput> & { line: string; ts: number }): LogRowInput => ({
  seq: o.ts,
  source: "native",
  stream: "log",
  target: "pane-1",
  ...o,
});

test("buildDisplayRows dedups consecutive identical lines with a count", () => {
  const rows = buildDisplayRows([
    e({ ts: 1000, line: "AQ TimeStretcher" }),
    e({ ts: 1000, line: "AQ TimeStretcher" }),
    e({ ts: 1000, line: "AQ TimeStretcher" }),
    e({ ts: 1000, line: "different" }),
  ]);
  expect(rows.map((r) => [r.e.line, r.count])).toEqual([
    ["AQ TimeStretcher", 3],
    ["different", 1],
  ]);
});

test("buildDisplayRows hides repeated metadata within the same source/pane/second", () => {
  const rows = buildDisplayRows([
    e({ ts: 1000, line: "a" }),
    e({ ts: 1200, line: "b" }), // same second + source + pane → no meta
    e({ ts: 2000, line: "c" }), // new second → show meta
    e({ ts: 2100, line: "d", target: "pane-2" }), // different pane → show meta
  ]);
  expect(rows.map((r) => r.showMeta)).toEqual([true, false, true, true]);
});

test("buildDisplayRows never dedups network/screenshot rows", () => {
  const rows = buildDisplayRows([
    e({ ts: 1, line: "GET /x", stream: "network", detail: { url: "http://x/" } }),
    e({ ts: 1, line: "GET /x", stream: "network", detail: { url: "http://x/" } }),
  ]);
  expect(rows).toHaveLength(2);
});

test("parseOsLog splits a dotted subsystem prefix", () => {
  expect(parseOsLog("[com.apple.network:connection] nw_socket ready")).toEqual({
    subsystem: "com.apple.network:connection",
    rest: "nw_socket ready",
  });
  expect(parseOsLog("[ReactNative] hello")).toBeNull(); // not dotted → not a subsystem
  expect(parseOsLog("plain message")).toBeNull();
});
