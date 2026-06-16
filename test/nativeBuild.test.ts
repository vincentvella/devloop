import { expect, test } from "bun:test";
import { availablePlatforms, buildCommand, fingerprintStatus, buildStatusLabel } from "../src/nativeBuild.ts";

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
