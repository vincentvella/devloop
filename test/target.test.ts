import { expect, test } from "bun:test";
import {
  detectTargetKind,
  capabilitiesFor,
  supports,
  toolCapability,
  isToolSupported,
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

test("web supports every capability; react-native is the observability subset", () => {
  const web = capabilitiesFor("web");
  for (const cap of ["navigate", "click", "snapshot", "emulate", "throttle", "evaluate", "screenshot"] as const) {
    expect(web.has(cap)).toBe(true);
  }
  const rn = capabilitiesFor("react-native");
  expect([...rn].sort()).toEqual(["evaluate", "screenshot"]);
  expect(supports("react-native", "evaluate")).toBe(true);
  expect(supports("react-native", "screenshot")).toBe(true);
  expect(supports("react-native", "click")).toBe(false);
  expect(supports("react-native", "snapshot")).toBe(false);
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
  // react-native Phase 1: eval + screenshot only
  expect(isToolSupported("react-native", "browser_eval")).toBe(true);
  expect(isToolSupported("react-native", "browser_screenshot")).toBe(true);
  expect(isToolSupported("react-native", "browser_snapshot")).toBe(false);
  expect(isToolSupported("react-native", "browser_click")).toBe(false);
  expect(isToolSupported("react-native", "browser_navigate")).toBe(false);
  // agnostic tools are always allowed, on any target
  expect(isToolSupported("react-native", "get_logs")).toBe(true);
  expect(isToolSupported("react-native", "diagnose")).toBe(true);
});

test("unsupportedToolMessage names the tool and target", () => {
  const m = unsupportedToolMessage("react-native", "browser_snapshot");
  expect(m).toContain("browser_snapshot");
  expect(m).toContain("react-native");
});
