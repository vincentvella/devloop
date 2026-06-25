import { expect, test } from "bun:test";
import { availablePlatforms, buildCommand, fingerprintStatus, buildStatusLabel, resolveNativeInfo } from "../src/nativeBuild.ts";

test("availablePlatforms reflects prebuilt native dirs, iOS first", () => {
  expect(availablePlatforms({ hasIosDir: true, hasAndroidDir: true })).toEqual(["ios", "android"]);
  expect(availablePlatforms({ hasIosDir: true })).toEqual(["ios"]);
  expect(availablePlatforms({ hasAndroidDir: true })).toEqual(["android"]);
  expect(availablePlatforms({})).toEqual([]);
});

test("buildCommand defaults to bunx expo run:<platform>", () => {
  expect(buildCommand("ios")).toEqual({ cmd: "bunx", args: ["expo", "run:ios"] });
  expect(buildCommand("android")).toEqual({ cmd: "bunx", args: ["expo", "run:android"] });
});

test("buildCommand honors npm package manager", () => {
  expect(buildCommand("ios", { packageManager: "npm" })).toEqual({ cmd: "npx", args: ["expo", "run:ios"] });
});

test("fingerprintStatus: fresh / stale / unknown", () => {
  expect(fingerprintStatus("abc", "abc")).toBe("fresh");
  expect(fingerprintStatus("abc", "xyz")).toBe("stale");
  expect(fingerprintStatus("abc", undefined)).toBe("unknown"); // never built via devloop
  expect(fingerprintStatus(undefined, "abc")).toBe("unknown"); // couldn't compute current
  expect(fingerprintStatus(null, null)).toBe("unknown");
});

test("buildStatusLabel: badge text only when actionable", () => {
  expect(buildStatusLabel("stale")).toBe("rebuild recommended");
  expect(buildStatusLabel("unknown")).toBe("build status unknown");
  expect(buildStatusLabel("fresh")).toBeNull();
});

test("resolveNativeInfo: web projects are not native", () => {
  expect(resolveNativeInfo("web", { hasIosDir: false })).toEqual({ isNative: false, platforms: [], targets: [], buildStatus: "unknown", badge: null });
});

test("resolveNativeInfo: RN project offers platforms + staleness badge", () => {
  const stale = resolveNativeInfo("react-native", { hasIosDir: true }, "now", "old");
  expect(stale).toMatchObject({ isNative: true, platforms: ["ios"], buildStatus: "stale", badge: "rebuild recommended" });

  const fresh = resolveNativeInfo("react-native", { hasIosDir: true, hasAndroidDir: true }, "h", "h");
  expect(fresh.platforms).toEqual(["ios", "android"]);
  expect(fresh.badge).toBeNull();
});

test("resolveNativeInfo: managed RN project (no native dirs) still offers iOS", () => {
  expect(resolveNativeInfo("react-native", {}).platforms).toEqual(["ios"]);
});

test("resolveNativeInfo: view targets — web added only when webCapable, iOS gated to macOS", () => {
  // webCapable + iosCapable (default true)
  expect(resolveNativeInfo("react-native", { hasIosDir: true }, null, null, true).targets).toEqual(["web", "ios", "android"]);
  expect(resolveNativeInfo("react-native", { hasIosDir: true }, null, null, false).targets).toEqual(["ios", "android"]);
  // iosCapable=false (Windows/Linux) — no iOS target (simulator/idb are macOS-only)
  expect(resolveNativeInfo("react-native", { hasIosDir: true }, null, null, true, false).targets).toEqual(["web", "android"]);
  expect(resolveNativeInfo("react-native", { hasIosDir: true }, null, null, false, false).targets).toEqual(["android"]);
  expect(resolveNativeInfo("web", {}, null, null, true).targets).toEqual([]); // not native → no targets
});
