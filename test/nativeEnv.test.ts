import { expect, test } from "bun:test";
import { nativeEnvIssues, nativeEnvReady, nativeEnvSummary } from "../src/nativeEnv.ts";

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
