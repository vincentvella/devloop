import { test, expect } from "bun:test";
import { scrollJs, selectJs, focusJs, centerJs } from "../src/pageActions.ts";

test("scrollJs targets a selector or window coords", () => {
  const sel = scrollJs({ selector: "#a" });
  expect(sel).toContain('querySelector("#a")');
  expect(sel).toContain("scrollIntoView");
  expect(scrollJs({ x: 10, y: 20 })).toContain("scrollTo(10,20)");
  expect(scrollJs({})).toContain("scrollTo(0,0)");
});

test("selectJs sets value and dispatches input+change", () => {
  const js = selectJs("#s", "v1");
  expect(js).toContain('querySelector("#s")');
  expect(js).toContain('"v1"');
  expect(js).toContain("input");
  expect(js).toContain("change");
});

test("focusJs / centerJs reference the selector", () => {
  expect(focusJs("#x")).toContain('querySelector("#x")');
  expect(focusJs("#x")).toContain(".focus()");
  expect(centerJs("#y")).toContain("getBoundingClientRect");
});

test("selectors with quotes are JSON-escaped (no injection)", () => {
  expect(focusJs('a[name="q"]')).toContain('querySelector("a[name=\\"q\\"]")');
});
