import { expect, test } from "bun:test";
import type { SnapNode } from "../src/pageSnapshot.ts";
import {
  connectFailureMessage,
  consoleArgsToText,
  errorStackFromArgs,
  type InspectorTarget,
  inspectorListUrl,
  isErrorConsoleType,
  resolvePoint,
  selectHermesTarget,
} from "../src/reactNative.ts";

const node = (name: string, ref: string): SnapNode => ({ ref, role: "button", name, tag: "native" });

test("connectFailureMessage distinguishes a busy/owned target from no target (#23)", () => {
  // saw a target but couldn't attach → another debugger likely owns it
  expect(connectFailureMessage(true)).toMatch(/couldn't attach|another debugger/i);
  // never saw a target → app not running / JS debugging off
  expect(connectFailureMessage(false)).toMatch(/no React Native .*target/i);
  expect(connectFailureMessage(true)).not.toBe(connectFailureMessage(false));
});

// Shapes taken from a real Caliburr /json/list (RN 0.83, new architecture).
const RUNTIME: InspectorTarget = {
  id: "dev-1",
  title: "coffee.caliburr.app (iPhone 17 Pro Max)",
  description: "React Native Bridgeless [C++ connection]",
  webSocketDebuggerUrl: "ws://localhost:8082/inspector/debug?device=dev&page=1",
  reactNative: { logicalDeviceId: "dev", capabilities: {} },
};
const UI_PAGE: InspectorTarget = {
  id: "dev-2",
  title: "coffee.caliburr.app (iPhone 17 Pro Max)",
  description: "UI [C++ connection]",
  webSocketDebuggerUrl: "ws://localhost:8082/inspector/debug?device=dev&page=2",
  reactNative: { logicalDeviceId: "dev" },
};

test("selectHermesTarget picks the JS runtime, not the UI page", () => {
  expect(selectHermesTarget([RUNTIME, UI_PAGE])?.webSocketDebuggerUrl).toBe(RUNTIME.webSocketDebuggerUrl);
  expect(selectHermesTarget([UI_PAGE, RUNTIME])?.description).toBe("React Native Bridgeless [C++ connection]");
});

test("selectHermesTarget prefers the most recent runtime after a reload", () => {
  const stale = {
    ...RUNTIME,
    id: "old",
    webSocketDebuggerUrl: "ws://localhost:8082/inspector/debug?device=dev&page=0",
  };
  // stale first, fresh last → fresh wins
  expect(selectHermesTarget([stale, UI_PAGE, RUNTIME])?.id).toBe("dev-1");
});

test("selectHermesTarget returns null when nothing is attachable", () => {
  expect(selectHermesTarget([])).toBeNull();
  expect(selectHermesTarget([{ title: "no ws" }])).toBeNull();
});

test("selectHermesTarget falls back to any ws target if none look like RN", () => {
  const generic: InspectorTarget = { title: "x", description: "page", webSocketDebuggerUrl: "ws://h/1" };
  expect(selectHermesTarget([generic])).toBe(generic);
});

test("isErrorConsoleType: error/assert are errors (the RN-via-console finding)", () => {
  expect(isErrorConsoleType("error")).toBe(true);
  expect(isErrorConsoleType("assert")).toBe(true);
  expect(isErrorConsoleType("log")).toBe(false);
  expect(isErrorConsoleType("warning")).toBe(false);
  expect(isErrorConsoleType("info")).toBe(false);
});

test("consoleArgsToText flattens values and object descriptions", () => {
  expect(
    consoleArgsToText([
      { type: "string", value: "user" },
      { type: "object", value: { id: 7 } },
    ]),
  ).toBe('user {"id":7}');
  expect(consoleArgsToText([{ type: "object", subtype: "error", description: "Error: boom\n at f" }])).toBe(
    "Error: boom\n at f",
  );
});

test("errorStackFromArgs extracts an Error object's stack, else null", () => {
  expect(errorStackFromArgs([{ subtype: "error", description: "Error: boom\n  at App (app.bundle:1:2)" }])).toContain(
    "at App",
  );
  expect(errorStackFromArgs([{ type: "string", value: "just a log" }])).toBeNull();
});

test("inspectorListUrl builds /json/list from a metro base", () => {
  expect(inspectorListUrl("http://localhost:8082")).toBe("http://localhost:8082/json/list");
  expect(inspectorListUrl("http://localhost:8082/")).toBe("http://localhost:8082/json/list");
});

test("resolvePoint: literal pt:x,y ref wins without consulting the snapshot", () => {
  expect(resolvePoint("pt:12,34", [])).toEqual({ x: 12, y: 34 });
});

test("resolvePoint: exact a11y-name match beats a substring superset", () => {
  const nodes = [node("Save draft", "pt:10,10"), node("Save", "pt:20,20")];
  // "Save" must hit the exact node, not the first substring match "Save draft".
  expect(resolvePoint("Save", nodes)).toEqual({ x: 20, y: 20 });
});

test("resolvePoint: unique substring match resolves", () => {
  const nodes = [node("Submit order", "pt:30,40"), node("Cancel", "pt:0,0")];
  expect(resolvePoint("Submit", nodes)).toEqual({ x: 30, y: 40 });
});

test("resolvePoint: ambiguous substring match throws instead of tapping the first (the footgun)", () => {
  const nodes = [node("Save draft", "pt:10,10"), node("Save changes", "pt:20,20")];
  expect(() => resolvePoint("Save", nodes)).toThrow(/ambiguous — 2 elements/);
});

test("resolvePoint: multiple exact matches are ambiguous too", () => {
  const nodes = [node("OK", "pt:1,1"), node("OK", "pt:2,2")];
  expect(() => resolvePoint("OK", nodes)).toThrow(/ambiguous/);
});

test("resolvePoint: no match throws a helpful not-found error", () => {
  expect(() => resolvePoint("Nope", [node("Yes", "pt:1,1")])).toThrow(/no native element matching "Nope"/);
});
