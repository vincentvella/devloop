import { expect, test } from "bun:test";
import { nativeEnvIssues, nativeEnvReady, nativeEnvSummary, nativeEnvChecks, androidEnvIssues, androidEnvReady, androidEnvChecks, androidEnvSummary } from "../src/nativeEnv.ts";

test("nativeEnvChecks yields a ✓/✗ row per requirement with a fix only when failing", () => {
  const checks = nativeEnvChecks({ idb: true, idbCompanion: false, bootedSim: true });
  expect(checks.map((c) => [c.label, c.ok])).toEqual([
    ["idb_companion", false],
    ["idb CLI (fb-idb)", true],
    ["Booted simulator", true],
  ]);
  expect(checks[0]!.fix).toContain("brew install facebook/fb/idb-companion");
  expect(checks[1]!.fix).toBeUndefined(); // ok → no fix
});

const ALL = { idb: true, idbCompanion: true, bootedSim: true };

test("ready when idb + companion + a booted sim are present", () => {
  expect(nativeEnvReady(ALL)).toBe(true);
  expect(nativeEnvIssues(ALL)).toEqual([]);
  expect(nativeEnvSummary(ALL)).toMatch(/ready/);
});

test("each missing piece yields an actionable fix, in install order", () => {
  const issues = nativeEnvIssues({ idb: false, idbCompanion: false, bootedSim: false });
  expect(issues.map((i) => i.what)).toEqual(["idb_companion not found", "idb CLI not found", "no booted simulator"]);
  expect(issues[0]!.fix).toContain("brew install facebook/fb/idb-companion");
  expect(issues[1]!.fix).toContain("Python <3.14"); // the gotcha that bit us
  expect(nativeEnvReady({ idb: false, idbCompanion: false, bootedSim: false })).toBe(false);
});

test("summary names the gap + fix when not ready", () => {
  const s = nativeEnvSummary({ idb: false, idbCompanion: true, bootedSim: true });
  expect(s).toContain("idb CLI not found");
  expect(s).toContain("pipx install fb-idb");
});

test("Android readiness needs only adb + a booted device", () => {
  expect(androidEnvReady({ adb: true, bootedDevice: true })).toBe(true);
  expect(androidEnvSummary({ adb: true, bootedDevice: true })).toMatch(/ready/);
  const issues = androidEnvIssues({ adb: false, bootedDevice: false });
  expect(issues.map((i) => i.what)).toEqual(["adb not found", "no booted device"]);
  expect(androidEnvChecks({ adb: true, bootedDevice: false }).map((c) => [c.label, c.ok])).toEqual([
    ["adb (Android SDK)", true],
    ["Booted device/emulator", false],
  ]);
});
