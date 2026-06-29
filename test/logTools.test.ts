import { expect, test } from "bun:test";
import { LogBuffer } from "../src/logBuffer.ts";
import { handleTool } from "../src/toolLayer.ts";
import { configure, parse } from "./handleToolHarness.ts";

/** A fresh buffer seeded with one of each kind of event. */
function seed(): LogBuffer {
  const buffer = new LogBuffer(100);
  buffer.push("server", "stdout", "server up on 3000");
  buffer.push("browser", "console", "[log] hello world");
  buffer.push("browser", "pageerror", "TypeError: boom");
  buffer.network("GET /api 500", { kind: "network", url: "/api", status: 500, method: "GET" }, undefined, true);
  return buffer;
}

test("get_logs returns count + latestSeq + entries (all four)", async () => {
  configure({ buffer: seed() });
  const r = parse(await handleTool("get_logs", {}));
  expect(r.count).toBe(4);
  expect(r.latestSeq).toBe(3);
  expect((r.entries as unknown[]).length).toBe(4);
});

test("get_logs honors grep / source / stream filters", async () => {
  configure({ buffer: seed() });
  expect(parse(await handleTool("get_logs", { grep: "hello" })).count).toBe(1);
  expect(parse(await handleTool("get_logs", { source: "server" })).count).toBe(1);
  expect(parse(await handleTool("get_logs", { stream: "pageerror" })).count).toBe(1);
});

test("get_logs_around returns the events near a timestamp", async () => {
  configure({ buffer: seed() });
  const r = parse(await handleTool("get_logs_around", { ts: Date.now(), windowMs: 60_000 }));
  expect(r.count).toBe(4);
});

test("clear_logs empties the buffer", async () => {
  configure({ buffer: seed() });
  expect(parse(await handleTool("clear_logs", {})).ok).toBe(true);
  expect(parse(await handleTool("get_logs", {})).count).toBe(0);
});

test("get_network returns the network ring entries with detail flattened", async () => {
  configure({ buffer: seed() });
  const net = parse(await handleTool("get_network", {})) as unknown as Array<Record<string, unknown>>;
  expect(net.length).toBe(1);
  expect(net[0]).toMatchObject({ url: "/api", status: 500, method: "GET" });
});

test("export_har returns a HAR 1.2 document", async () => {
  configure({ buffer: seed() });
  const har = parse(await handleTool("export_har", {})) as { log: { version: string; entries: unknown[] } };
  expect(har.log.version).toBe("1.2");
  expect(har.log.entries.length).toBe(1);
});

test("diagnose returns a summary", async () => {
  configure({ buffer: seed() });
  const r = parse(await handleTool("diagnose", {}));
  expect(typeof r.summary).toBe("string");
});

test("export_bundle returns a bundle object", async () => {
  configure({ buffer: seed() });
  const r = parse(await handleTool("export_bundle", {}));
  expect(typeof r).toBe("object");
  expect(r).toBeTruthy();
});
