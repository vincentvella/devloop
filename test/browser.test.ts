import { expect, mock, test } from "bun:test";
import { PuppeteerBrowserController } from "../src/browser.ts";
import { LogBuffer } from "../src/logBuffer.ts";

// biome-ignore lint/suspicious/noExplicitAny: these tests fake Puppeteer's Page/CDP/HTTP surface
type Any = any;

const OPTS = { headless: true, networkErrorThreshold: 400, actionTimeoutMs: 1000, navTimeoutMs: 1000 };
const makeCtrl = (buffer: LogBuffer): Any => new PuppeteerBrowserController(buffer, OPTS) as unknown as Any;

/** A fake Puppeteer Page: records its event handlers, satisfies setupPage()'s calls. */
function makePage(over: Record<string, Any> = {}): Any {
  const handlers: Record<string, (...a: Any[]) => Any> = {};
  const page: Any = {
    handlers,
    closed: false,
    isClosed: () => page.closed,
    url: () => "http://localhost:3000/",
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    once: (ev: string, fn: Any) => {
      handlers[`once:${ev}`] = fn;
    },
    on: (ev: string, fn: Any) => {
      handlers[ev] = fn;
    },
    createCDPSession: mock(async () => ({ send: mock(async () => ({ result: { value: undefined } })) })),
    goto: mock(async () => ({ status: () => 200 })),
    ...over,
  };
  return page;
}

const makeBrowser = (pages: Any[]): Any => ({ pages: mock(async () => pages), newPage: mock(async () => makePage()) });

const fakeReq = (over: Record<string, Any> = {}): Any => ({
  method: () => "GET",
  url: () => "http://h/api",
  resourceType: () => "fetch",
  headers: () => ({}),
  postData: () => undefined,
  failure: () => null,
  ...over,
});

// --- enrichConsole: reserve-then-fill arg resolution ---

test("enrichConsole upgrades a JSHandle placeholder to the resolved value", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const entry = buffer.push("browser", "console", "[log] JSHandle@object", { type: "log" });
  const handle = { jsonValue: async () => ({ id: 7 }), toString: () => "[obj]" };
  const msg = {
    args: () => [handle],
    type: () => "log",
    text: () => "x",
    location: () => ({ url: "u", lineNumber: 1 }),
  };
  await ctrl.enrichConsole(msg, entry);
  expect(entry.line).toBe('[log] {"id":7}');
  expect((entry.detail as Any).args).toEqual([{ id: 7 }]);
});

test("enrichConsole falls back to toString for non-serializable args", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const entry = buffer.push("browser", "console", "[log] x", { type: "log" });
  const handle = {
    jsonValue: async () => {
      throw new Error("circular");
    },
    toString: () => "[Window]",
  };
  const msg = {
    args: () => [handle],
    type: () => "log",
    text: () => "x",
    location: () => ({ url: "", lineNumber: 0 }),
  };
  await ctrl.enrichConsole(msg, entry);
  expect(entry.line).toBe("[log] [Window]");
});

test("enrichConsole leaves the entry untouched when there are no args", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const entry = buffer.push("browser", "console", "[log] plain", { type: "log" });
  const msg = { args: () => [], type: () => "log", text: () => "plain", location: () => ({ url: "", lineNumber: 0 }) };
  await ctrl.enrichConsole(msg, entry);
  expect(entry.line).toBe("[log] plain");
});

// --- network listeners → LogBuffer ---

test("a response >= threshold lands on the timeline AND the ring, body fetched", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const page = makePage();
  ctrl.attachListeners(page);
  await page.handlers.response({
    status: () => 404,
    statusText: () => "Not Found",
    url: () => "http://h/api",
    headers: () => ({ "content-type": "application/json" }),
    request: () => fakeReq(),
    buffer: async () => Buffer.from('{"e":1}'),
  });
  const hit = buffer.netEntries().find((e) => (e.detail as Any).status === 404);
  expect(hit).toBeDefined();
  expect((hit!.detail as Any).responseBody).toBe('{"e":1}');
  expect(buffer.query({ stream: "network" }).some((e) => e.line.includes("404"))).toBe(true); // timeline
});

test("a response < threshold stays in the ring only (off the timeline)", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const page = makePage();
  ctrl.attachListeners(page);
  await page.handlers.response({
    status: () => 200,
    statusText: () => "OK",
    url: () => "http://h/ok",
    headers: () => ({}),
    request: () => fakeReq(),
    buffer: async () => Buffer.from("ok"),
  });
  expect(buffer.netEntries().some((e) => (e.detail as Any).status === 200)).toBe(true);
  expect(buffer.query({ stream: "network" }).some((e) => (e.detail as Any).status === 200)).toBe(false);
});

test("requestfailed records the failure on the timeline + ring", () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const page = makePage();
  ctrl.attachListeners(page);
  page.handlers.requestfailed(
    fakeReq({ url: () => "http://h/x", failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }) }),
  );
  const failed = buffer.netEntries().find((e) => (e.detail as Any).failure);
  expect((failed!.detail as Any).failure).toBe("net::ERR_CONNECTION_REFUSED");
  expect(buffer.query({ stream: "network" }).some((e) => e.line.startsWith("FAILED"))).toBe(true);
});

test("response body decoding flags binary payloads instead of dumping bytes", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  const page = makePage();
  ctrl.attachListeners(page);
  await page.handlers.response({
    status: () => 500,
    statusText: () => "err",
    url: () => "http://h/bin",
    headers: () => ({}),
    request: () => fakeReq(),
    buffer: async () => Buffer.from([0, 1, 2, 3]),
  });
  const e = buffer.netEntries().find((x) => (x.detail as Any).status === 500);
  expect((e!.detail as Any).responseBody).toMatch(/<binary 4 bytes>/);
});

// --- withRecovery: self-healing on stale-target errors ---

test("withRecovery re-acquires the page and retries once on a stale-target error", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  ctrl.browser = makeBrowser([makePage({ goto: mock(async () => ({ status: () => 200 })) })]);
  ctrl.page = makePage({
    goto: mock(async () => {
      throw new Error("Target closed");
    }),
  });
  const out = await ctrl.navigate("http://h/app");
  expect(out.status).toBe(200);
  expect(buffer.query({ stream: "pageerror" }).some((e) => e.line.includes("recovering"))).toBe(true);
});

test("withRecovery propagates a non-stale error without retrying", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  ctrl.browser = makeBrowser([makePage()]);
  ctrl.page = makePage({
    goto: mock(async () => {
      throw new Error("kaboom — a real bug, not a lost target");
    }),
  });
  await expect(ctrl.navigate("http://h/app")).rejects.toThrow(/kaboom/);
});

test("withRecovery propagates when the retry also hits a stale target", async () => {
  const buffer = new LogBuffer(50);
  const ctrl = makeCtrl(buffer);
  ctrl.browser = makeBrowser([
    makePage({
      goto: mock(async () => {
        throw new Error("Session closed");
      }),
    }),
  ]);
  ctrl.page = makePage({
    goto: mock(async () => {
      throw new Error("Target closed");
    }),
  });
  await expect(ctrl.navigate("http://h/app")).rejects.toThrow(/Session closed/);
});
