import { expect, test } from "bun:test";
import {
  selectHermesTarget,
  isErrorConsoleType,
  consoleArgsToText,
  errorStackFromArgs,
  inspectorListUrl,
  type InspectorTarget,
} from "../src/reactNative.ts";

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
  const stale = { ...RUNTIME, id: "old", webSocketDebuggerUrl: "ws://localhost:8082/inspector/debug?device=dev&page=0" };
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
  expect(consoleArgsToText([{ type: "string", value: "user" }, { type: "object", value: { id: 7 } }])).toBe('user {"id":7}');
  expect(consoleArgsToText([{ type: "object", subtype: "error", description: "Error: boom\n at f" }])).toBe("Error: boom\n at f");
});

test("errorStackFromArgs extracts an Error object's stack, else null", () => {
  expect(errorStackFromArgs([{ subtype: "error", description: "Error: boom\n  at App (app.bundle:1:2)" }])).toContain("at App");
  expect(errorStackFromArgs([{ type: "string", value: "just a log" }])).toBeNull();
});

test("inspectorListUrl builds /json/list from a metro base", () => {
  expect(inspectorListUrl("http://localhost:8082")).toBe("http://localhost:8082/json/list");
  expect(inspectorListUrl("http://localhost:8082/")).toBe("http://localhost:8082/json/list");
});
