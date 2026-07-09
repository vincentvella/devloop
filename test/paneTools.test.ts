import { expect, test } from "bun:test";
import { handleTool } from "../src/toolLayer.ts";
import { configure, makeBrowser, parse } from "./handleToolHarness.ts";

test("pane_list returns the manager's panes", async () => {
  const { browser } = configure();
  const r = parse(await handleTool("pane_list", {}));
  expect(r.panes).toEqual([{ id: "p1", url: "http://x/", active: true, label: "Web" }]);
  expect(browser.listPanes).toHaveBeenCalled();
});

test("pane_new forwards the url (unscoped: no label/cmd/cwd)", async () => {
  const { browser } = configure();
  const r = parse(await handleTool("pane_new", { url: "http://localhost:3000" }));
  expect(r).toMatchObject({ id: "p2", url: "http://localhost:3000" });
  expect(browser.newPane).toHaveBeenCalledWith("http://localhost:3000", undefined, undefined, undefined);
});

test("pane_new scopes the pane to a cwd and names it from the basename", async () => {
  const { browser } = configure();
  await handleTool("pane_new", { url: "http://localhost:3000", cwd: "/repos/web", cmd: "bun run dev" });
  expect(browser.newPane).toHaveBeenCalledWith("http://localhost:3000", "web", "bun run dev", "/repos/web");
});

test("pane_select / pane_pop return the pane", async () => {
  configure();
  expect(parse(await handleTool("pane_select", { id: "p1" })).id).toBe("p1");
  expect(parse(await handleTool("pane_pop", { id: "p1" })).popped).toBe(true);
});

test("pane_close returns {closed}", async () => {
  const { browser } = configure();
  expect(parse(await handleTool("pane_close", { id: "p1" })).closed).toBe(true);
  expect(browser.closePane).toHaveBeenCalledWith("p1");
});

test("pane_set_label calls setLabel and returns ok", async () => {
  const { browser } = configure();
  expect(parse(await handleTool("pane_set_label", { id: "p1", label: "Caliburr" })).ok).toBe(true);
  expect(browser.setLabel).toHaveBeenCalledWith("p1", "Caliburr");
});

test("pane_* in single-pane mode (no listPanes) report the cockpit is required", async () => {
  configure({ browser: makeBrowser({ listPanes: undefined }) });
  await expect(handleTool("pane_list", {})).rejects.toThrow(/cockpit/i);
  await expect(handleTool("pane_new", {})).rejects.toThrow(/cockpit/i);
});
