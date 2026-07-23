import { expect, test } from "bun:test";
import {
  buildFailureDetail,
  buildResponseDetail,
  cap,
  originForClear,
  type RemoteObject,
  type ReqRecord,
  renderConsole,
  renderRemote,
} from "../src/electronBrowser.ts";

// --- cap ---------------------------------------------------------------------

test("cap: passes undefined through, keeps under-limit, truncates over-limit with a … suffix", () => {
  expect(cap(undefined)).toBeUndefined();
  expect(cap("short", 10)).toBe("short");
  expect(cap("abcdef", 3)).toBe("abc…(3 more)");
  // the ellipsis is one char, not "..."
  expect(cap("abcdef", 3)).not.toContain("...");
});

test("cap: empty string is preserved, not treated as nullish", () => {
  expect(cap("")).toBe("");
});

// --- renderRemote ------------------------------------------------------------

const ro = (o: Partial<RemoteObject>): RemoteObject => ({ type: "object", ...o });

test("renderRemote: string values pass through; non-strings are JSON-stringified", () => {
  expect(renderRemote(ro({ type: "string", value: "hi" }))).toBe("hi");
  expect(renderRemote(ro({ type: "number", value: 42 }))).toBe("42");
  expect(renderRemote(ro({ value: { a: 1 } }))).toBe('{"a":1}');
});

test("renderRemote: falsy-but-defined values render (only undefined falls through)", () => {
  expect(renderRemote(ro({ type: "boolean", value: false }))).toBe("false");
  expect(renderRemote(ro({ type: "number", value: 0 }))).toBe("0");
  expect(renderRemote(ro({ value: null }))).toBe("null");
});

test("renderRemote: unserializableValue, object/array previews, and the fallback", () => {
  expect(renderRemote(ro({ unserializableValue: "Infinity" }))).toBe("Infinity");
  expect(
    renderRemote(
      ro({
        preview: {
          properties: [
            { name: "a", value: "1" },
            { name: "b", value: "2" },
          ],
        },
      }),
    ),
  ).toBe("{a: 1, b: 2}");
  expect(
    renderRemote(ro({ subtype: "array", preview: { properties: [{ name: "0", value: "9" }], overflow: true } })),
  ).toBe("[0: 9, …]");
  expect(renderRemote(ro({ type: "function", description: "fn()" }))).toBe("fn()");
  expect(renderRemote(ro({ type: "symbol" }))).toBe("<symbol>");
});

// --- renderConsole -----------------------------------------------------------

test("renderConsole: builds a [type] line + detail with resolved args", () => {
  const c = renderConsole({
    type: "log",
    args: [ro({ type: "string", value: "hello" }), ro({ type: "number", value: 5 })],
  });
  expect(c).not.toBeNull();
  expect(c!.line).toBe("[log] hello 5");
  expect(c!.detail).toEqual({ type: "log", args: ["hello", 5] });
});

test("renderConsole: suppresses Electron's dev-only security warning (returns null)", () => {
  const c = renderConsole({
    type: "warning",
    args: [ro({ type: "string", value: "Electron Security Warning (Insecure CSP)" })],
  });
  expect(c).toBeNull();
});

// --- buildResponseDetail -----------------------------------------------------

const req = (o: Partial<ReqRecord> = {}): ReqRecord => ({ url: "http://x/a", method: "GET", startedAt: 1000, ...o });

test("buildResponseDetail: composes line + NetDetail, computes durationMs from now", () => {
  const params = {
    type: "XHR",
    response: { url: "http://x/a", status: 200, statusText: "OK", mimeType: "application/json", headers: { h: "1" } },
  };
  const { line, detail } = buildResponseDetail(params, req({ headers: { "x-req": "y" }, postData: "body" }), 1500);
  expect(line).toBe("200 GET http://x/a");
  expect(detail.status).toBe(200);
  expect(detail.durationMs).toBe(500); // now(1500) - startedAt(1000)
  expect(detail.requestHeaders).toEqual({ "x-req": "y" });
  expect(detail.requestBody).toBe("body");
});

test("buildResponseDetail: tolerates a missing request record (durationMs undefined, line trims)", () => {
  const params = { type: "Document", response: { url: "http://x/", status: 500, statusText: "Err", headers: {} } };
  const { line, detail } = buildResponseDetail(params, undefined, 2000);
  // Pre-existing cosmetic quirk, preserved by the extraction: a missing method
  // leaves an interior double space that .trim() doesn't collapse.
  expect(line).toBe("500  http://x/");
  expect(detail.durationMs).toBeUndefined();
  expect(detail.method).toBeUndefined();
});

// --- buildFailureDetail ------------------------------------------------------

test("buildFailureDetail: FAILED line + failure detail, falls back to requestId when no req", () => {
  const withReq = buildFailureDetail({ requestId: "r1", errorText: "net::ERR_ABORTED" }, req(), 1200);
  expect(withReq.line).toBe("FAILED GET http://x/a — net::ERR_ABORTED");
  expect(withReq.detail.failure).toBe("net::ERR_ABORTED");
  expect(withReq.detail.durationMs).toBe(200);

  const noReq = buildFailureDetail({ requestId: "r2", errorText: "net::ERR_FAILED" }, undefined, 0);
  expect(noReq.line).toBe("FAILED  r2 — net::ERR_FAILED");
  expect(noReq.detail.url).toBe("r2");
});

// --- originForClear ----------------------------------------------------------

test("originForClear: http/https → scoped origin; everything else → undefined (all origins)", () => {
  expect(originForClear("http://localhost:3000/path?q=1")).toBe("http://localhost:3000");
  expect(originForClear("https://example.com/a")).toBe("https://example.com");
  expect(originForClear("file:///Users/x/index.html")).toBeUndefined();
  expect(originForClear("about:blank")).toBeUndefined();
  expect(originForClear("not a url")).toBeUndefined();
  expect(originForClear("")).toBeUndefined();
});
