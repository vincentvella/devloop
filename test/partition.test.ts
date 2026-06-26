import { expect, test } from "bun:test";
import { DEFAULT_PARTITION, normalizeCwd, partitionForCwd } from "../src/partition.ts";

test("no cwd → the shared default partition (legacy behavior)", () => {
  expect(partitionForCwd(undefined)).toBe(DEFAULT_PARTITION);
  expect(partitionForCwd(null)).toBe(DEFAULT_PARTITION);
  expect(partitionForCwd("")).toBe(DEFAULT_PARTITION);
  expect(partitionForCwd("   ")).toBe(DEFAULT_PARTITION);
});

test("a cwd → a stable, persist: project partition", () => {
  const p = partitionForCwd("/Users/me/apps/store");
  expect(p).toMatch(/^persist:devloop-proj-[0-9a-f]{12}$/);
  expect(partitionForCwd("/Users/me/apps/store")).toBe(p); // deterministic
});

test("different projects get different partitions (the footgun fix)", () => {
  expect(partitionForCwd("/apps/a")).not.toBe(partitionForCwd("/apps/b"));
});

test("trivial cwd differences normalize to one project", () => {
  expect(normalizeCwd("/apps/store/")).toBe("/apps/store");
  expect(partitionForCwd("/apps/store")).toBe(partitionForCwd("/apps/store/"));
  expect(partitionForCwd("/apps/store")).toBe(partitionForCwd("  /apps/store  "));
});
