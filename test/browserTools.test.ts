import { expect, mock, test } from "bun:test";
import { handleTool } from "../src/toolLayer.ts";
import { configure, makeBrowser, parse } from "./handleToolHarness.ts";

test("browser_navigate returns {url,status} and calls navigate", async () => {
  const { browser } = configure();
  const r = parse(await handleTool("browser_navigate", { url: "http://x/" }));
  expect(r).toEqual({ url: "http://x/", status: 200 });
  expect(browser.navigate).toHaveBeenCalledWith("http://x/");
});

test("browser_back / forward / reload → {ok:true}", async () => {
  const { browser } = configure();
  expect(parse(await handleTool("browser_back", {})).ok).toBe(true);
  expect(parse(await handleTool("browser_forward", {})).ok).toBe(true);
  expect(parse(await handleTool("browser_reload", { hard: true })).ok).toBe(true);
  expect(browser.reload).toHaveBeenCalledWith(true);
});

test("browser_screenshot returns an image content block", async () => {
  configure();
  const r = await handleTool("browser_screenshot", { fullPage: true });
  expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
});

test("browser_click / type pass selector + text", async () => {
  const { browser } = configure();
  expect(parse(await handleTool("browser_click", { selector: "#go" })).ok).toBe(true);
  expect(browser.click).toHaveBeenCalledWith("#go");
  await handleTool("browser_type", { selector: "#name", text: "vince" });
  expect(browser.type).toHaveBeenCalledWith("#name", "vince");
});

test("browser_eval returns the evaluated value", async () => {
  configure();
  expect(parse(await handleTool("browser_eval", { expression: "1+1" })).value).toBe(42);
});

test("browser_hover / select / press echo their target", async () => {
  configure();
  expect(parse(await handleTool("browser_hover", { selector: "#h" })).hovered).toBe("#h");
  expect(parse(await handleTool("browser_select", { selector: "#s", value: "v" })).selected).toBe("v");
  expect(parse(await handleTool("browser_press", { key: "Enter" })).pressed).toBe("Enter");
});

test("browser_scroll passes selector/x/y and returns ok", async () => {
  const { browser } = configure();
  expect(parse(await handleTool("browser_scroll", { x: 0, y: 100 })).ok).toBe(true);
  expect(browser.scroll).toHaveBeenCalledWith({ selector: undefined, x: 0, y: 100 });
});

test("browser_clear_storage / emulate / throttle → ok, with args forwarded", async () => {
  const { browser } = configure();
  expect(parse(await handleTool("browser_clear_storage", { allOrigins: true })).ok).toBe(true);
  expect(browser.clearStorage).toHaveBeenCalledWith({ allOrigins: true });
  expect(parse(await handleTool("browser_emulate", { device: "iphone" })).ok).toBe(true);
  expect(browser.emulate).toHaveBeenCalledWith(expect.objectContaining({ device: "iphone" }));
  expect(parse(await handleTool("browser_throttle", { profile: "slow-3g" })).ok).toBe(true);
  expect(browser.throttle).toHaveBeenCalledWith("slow-3g");
});

test("browser_wait_for_idle → {ok:true}, and {ok:false} when it times out", async () => {
  configure();
  expect(parse(await handleTool("browser_wait_for_idle", {})).ok).toBe(true);
  configure({
    browser: makeBrowser({
      waitForNetworkIdle: mock(async () => {
        throw new Error("timeout");
      }),
    }),
  });
  expect(parse(await handleTool("browser_wait_for_idle", { timeoutMs: 10 })).ok).toBe(false);
});

test("browser_snapshot / wait_for return their structured payloads", async () => {
  configure();
  expect(parse(await handleTool("browser_snapshot", {})).title).toBe("T");
  const w = parse(await handleTool("browser_wait_for", { selector: "#x" }));
  expect(w).toMatchObject({ ok: true });
});

test("a rejecting browser primitive surfaces as a thrown error (caught by buildMcpServer)", async () => {
  configure({
    browser: makeBrowser({
      click: mock(async () => {
        throw new Error("element not found");
      }),
    }),
  });
  await expect(handleTool("browser_click", { selector: "#missing" })).rejects.toThrow(/element not found/);
});
