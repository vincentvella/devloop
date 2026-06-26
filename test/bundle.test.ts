import { expect, test } from "bun:test";
import { buildBundle, bundleToHtml } from "../src/bundle.ts";
import type { LogEntry } from "../src/logBuffer.ts";

const e = (over: Partial<LogEntry>): LogEntry => ({
  seq: 0,
  ts: 1000,
  source: "browser",
  stream: "console",
  line: "",
  ...over,
});

test("buildBundle assembles diagnose + har + screenshots and strips screenshot images from logs", () => {
  const entries = [
    e({ stream: "console", line: "[error] boom", ts: 100 }),
    e({
      stream: "network",
      line: "500 GET /x",
      detail: { kind: "network", url: "http://h/x", method: "GET", status: 500 },
      ts: 200,
    }),
    e({
      stream: "screenshot",
      line: "screenshot",
      detail: { image: "data:image/png;base64,AAAA" },
      ts: 300,
      target: "pane-1",
    }),
    e({ stream: "console", line: "[log] ok", ts: 400 }),
  ];
  const b = buildBundle(entries, { app: "myapp" });
  expect(b.meta.app).toBe("myapp");
  expect(b.meta.counts.logs).toBe(4);
  expect(b.diagnose.errorCount).toBeGreaterThanOrEqual(2);
  expect((b.har as { log: { entries: unknown[] } }).log.entries.length).toBe(1);
  expect(b.screenshots.length).toBe(1);
  expect(b.screenshots[0]!.image).toContain("base64");
  // the big image data is moved out of the logs copy
  const slog = b.logs.find((l) => l.stream === "screenshot");
  expect((slog?.detail as { image?: string } | undefined)?.image).toBeUndefined();
});

test("buildBundle windowMs filters", () => {
  const b = buildBundle(
    [e({ stream: "pageerror", line: "old", ts: 1000 }), e({ stream: "pageerror", line: "new", ts: 9000 })],
    { windowMs: 2000, now: 10_000 },
  );
  expect(b.meta.counts.logs).toBe(1);
});

test("bundleToHtml is a self-contained report containing the error + a screenshot", () => {
  const b = buildBundle(
    [
      e({ stream: "pageerror", line: "Error: kaput", ts: 100 }),
      e({ stream: "screenshot", detail: { image: "data:image/png;base64,ZZZZ" }, ts: 200 }),
    ],
    {},
  );
  const html = bundleToHtml(b);
  expect(html).toContain("<html");
  expect(html.toLowerCase()).toContain("devloop");
  expect(html).toContain("Error: kaput");
  expect(html).toContain("data:image/png;base64,ZZZZ");
});

test("bundleToHtml escapes HTML in log lines", () => {
  const b = buildBundle([e({ stream: "pageerror", line: "<script>alert(1)</script>", ts: 100 })], {});
  const html = bundleToHtml(b);
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});
