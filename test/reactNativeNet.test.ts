import { expect, test } from "bun:test";
import { NET_INTERCEPTOR_JS, NET_MARKER, parseNetMarker } from "../src/reactNativeNet.ts";

test("parseNetMarker turns a marker into a NetDetail timeline row", () => {
  const ev = {
    kind: "network",
    method: "GET",
    url: "https://api.example.com/recipes?q=espresso",
    status: 200,
    durationMs: 142,
    requestHeaders: { accept: "application/json" },
    responseHeaders: { "content-type": "application/json" },
    mimeType: "application/json",
    responseBody: '{"ok":true}',
  };
  const out = parseNetMarker(NET_MARKER + JSON.stringify(ev))!;
  expect(out.line).toBe("200 GET https://api.example.com/recipes?q=espresso");
  expect(out.detail).toMatchObject({
    kind: "network",
    method: "GET",
    status: 200,
    durationMs: 142,
    mimeType: "application/json",
    responseBody: '{"ok":true}',
  });
  expect(out.detail.requestHeaders).toEqual({ accept: "application/json" });
});

test("parseNetMarker marks failures (status 0)", () => {
  const ev = { kind: "network", method: "POST", url: "https://api.example.com/x", status: 0, failure: "network error" };
  const out = parseNetMarker(NET_MARKER + JSON.stringify(ev))!;
  expect(out.line).toBe("FAILED POST https://api.example.com/x");
  expect(out.detail.failure).toBe("network error");
});

test("parseNetMarker ignores non-markers + junk", () => {
  expect(parseNetMarker("[log] just a console line")).toBeNull();
  expect(parseNetMarker(NET_MARKER + "not json")).toBeNull();
  expect(parseNetMarker(NET_MARKER + JSON.stringify({ method: "GET" }))).toBeNull(); // no url
});

test("interceptor snippet is a self-contained, idempotent IIFE that emits the marker", () => {
  expect(NET_INTERCEPTOR_JS).toContain("__DEVLOOP_NET_HOOKED__"); // idempotency guard
  expect(NET_INTERCEPTOR_JS).toContain("XMLHttpRequest");
  expect(NET_INTERCEPTOR_JS).toContain(`'${NET_MARKER}'`);
  expect(NET_INTERCEPTOR_JS).not.toContain("require("); // no module resolution — patches the global
  expect(NET_INTERCEPTOR_JS.trim().startsWith("(function()")).toBe(true);
});
