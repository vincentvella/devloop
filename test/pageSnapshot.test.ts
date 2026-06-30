import { expect, test } from "bun:test";
import { DEFAULT_SNAPSHOT_MAX, SNAPSHOT_JS, snapshotJs } from "../src/pageSnapshot.ts";

test("snapshotJs injects the requested element cap", () => {
  expect(snapshotJs(500)).toContain("const MAX = 500");
  expect(snapshotJs(1000)).toContain("const MAX = 1000");
});

test("snapshotJs uses the default cap when omitted; SNAPSHOT_JS matches it", () => {
  expect(DEFAULT_SNAPSHOT_MAX).toBeGreaterThan(0);
  expect(snapshotJs()).toContain(`const MAX = ${DEFAULT_SNAPSHOT_MAX}`);
  expect(SNAPSHOT_JS).toBe(snapshotJs());
});

test("snapshotJs falls back to the default for invalid limits", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(snapshotJs(bad)).toContain(`const MAX = ${DEFAULT_SNAPSHOT_MAX}`);
  }
});
