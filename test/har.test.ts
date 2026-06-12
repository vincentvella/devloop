import { test, expect } from "bun:test";
import { toHar } from "../src/har.ts";
import type { LogEntry } from "../src/logBuffer.ts";

const net = (detail: unknown, over: Partial<LogEntry> = {}): LogEntry => ({
  seq: 1,
  ts: 1000,
  source: "browser",
  stream: "network",
  line: "x",
  detail,
  ...over,
});

test("toHar builds HAR 1.2 entries from network logs and ignores non-network", () => {
  const har = toHar([
    net({
      kind: "network",
      url: "http://x/a",
      method: "GET",
      status: 500,
      statusText: "Server Error",
      mimeType: "application/json",
      durationMs: 42,
      requestHeaders: { accept: "*/*" },
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"e":1}',
    }),
    { seq: 2, ts: 2000, source: "server", stream: "stdout", line: "ignored" },
    { seq: 3, ts: 2000, source: "browser", stream: "console", line: "also ignored" },
  ]) as { log: { version: string; entries: any[] } };

  expect(har.log.version).toBe("1.2");
  expect(har.log.entries.length).toBe(1);
  const e = har.log.entries[0];
  expect(e.request.method).toBe("GET");
  expect(e.request.url).toBe("http://x/a");
  expect(e.request.headers).toContainEqual({ name: "accept", value: "*/*" });
  expect(e.response.status).toBe(500);
  expect(e.response.statusText).toBe("Server Error");
  expect(e.response.content.text).toBe('{"e":1}');
  expect(e.response.content.mimeType).toBe("application/json");
  expect(e.time).toBe(42);
  expect(e.startedDateTime).toBe(new Date(1000).toISOString());
});

test("toHar represents failures and request bodies", () => {
  const har = toHar([net({ kind: "network", url: "http://x/b", method: "POST", failure: "net::ERR_FAILED", requestBody: "q=1" })]) as {
    log: { entries: any[] };
  };
  const e = har.log.entries[0];
  expect(e.response.status).toBe(0);
  expect(e._failure).toBe("net::ERR_FAILED");
  expect(e.request.postData.text).toBe("q=1");
});

test("toHar on an empty/no-network set yields an empty HAR", () => {
  const har = toHar([]) as { log: { entries: any[] } };
  expect(har.log.entries).toEqual([]);
});
