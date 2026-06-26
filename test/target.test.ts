import { expect, test } from "bun:test";
import {
  capabilitiesFor,
  detectTargetKind,
  isToolSupported,
  supports,
  toolCapability,
  unsupportedToolMessage,
} from "../src/target.ts";

test("detectTargetKind: web when no RN/Expo signals", () => {
  expect(detectTargetKind({ dependencies: { next: "15", react: "19" } })).toBe("web");
  expect(detectTargetKind({})).toBe("web");
  // react-native-web alone (Expo-less) is a web project — exact key match, not substring
  expect(detectTargetKind({ dependencies: { "react-native-web": "0.21" } })).toBe("web");
});

test("detectTargetKind: react-native via expo or react-native dep, or native dirs", () => {
  expect(detectTargetKind({ dependencies: { expo: "~55.0.0" } })).toBe("react-native");
  expect(detectTargetKind({ dependencies: { "react-native": "0.83.4" } })).toBe("react-native");
  expect(detectTargetKind({ devDependencies: { expo: "55" } })).toBe("react-native");
  expect(detectTargetKind({ hasIosDir: true })).toBe("react-native");
  expect(detectTargetKind({ hasAndroidDir: true })).toBe("react-native");
});

test("web supports every capability; react-native is observability + idb interactions", () => {
  const web = capabilitiesFor("web");
  for (const cap of ["navigate", "click", "snapshot", "emulate", "throttle", "evaluate", "screenshot"] as const) {
    expect(web.has(cap)).toBe(true);
  }
  const rn = capabilitiesFor("react-native");
  expect([...rn].sort()).toEqual(["click", "evaluate", "press", "screenshot", "scroll", "snapshot", "type"]);
  // supported on native via idb: eval/screenshot + tap/type/scroll/press/snapshot
  for (const cap of ["evaluate", "screenshot", "click", "type", "scroll", "press", "snapshot"] as const) {
    expect(supports("react-native", cap)).toBe(true);
  }
  // still web-only / not applicable to native
  for (const cap of [
    "navigate",
    "hover",
    "select",
    "emulate",
    "throttle",
    "clearStorage",
    "waitFor",
    "waitForNetworkIdle",
  ] as const) {
    expect(supports("react-native", cap)).toBe(false);
  }
});

test("toolCapability maps gated tools and ignores agnostic ones", () => {
  expect(toolCapability("browser_snapshot")).toBe("snapshot");
  expect(toolCapability("browser_eval")).toBe("evaluate");
  expect(toolCapability("get_logs")).toBeNull();
  expect(toolCapability("dev_start")).toBeNull();
  expect(toolCapability("diagnose")).toBeNull();
});

test("isToolSupported gates by the active target's capabilities", () => {
  // web: everything goes
  expect(isToolSupported("web", "browser_snapshot")).toBe(true);
  expect(isToolSupported("web", "browser_click")).toBe(true);
  // react-native: observability + idb interactions/snapshot
  expect(isToolSupported("react-native", "browser_eval")).toBe(true);
  expect(isToolSupported("react-native", "browser_screenshot")).toBe(true);
  expect(isToolSupported("react-native", "browser_snapshot")).toBe(true);
  expect(isToolSupported("react-native", "browser_click")).toBe(true);
  expect(isToolSupported("react-native", "browser_type")).toBe(true);
  expect(isToolSupported("react-native", "browser_scroll")).toBe(true);
  expect(isToolSupported("react-native", "browser_press")).toBe(true);
  // still gated off on native
  expect(isToolSupported("react-native", "browser_navigate")).toBe(false);
  expect(isToolSupported("react-native", "browser_hover")).toBe(false);
  // agnostic tools are always allowed, on any target
  expect(isToolSupported("react-native", "get_logs")).toBe(true);
  expect(isToolSupported("react-native", "diagnose")).toBe(true);
});

test("unsupportedToolMessage names the tool and target", () => {
  const m = unsupportedToolMessage("react-native", "browser_snapshot");
  expect(m).toContain("browser_snapshot");
  expect(m).toContain("react-native");
});
