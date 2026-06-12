import { expect, test } from "bun:test";
import {
  parseSemver,
  compareSemver,
  isNewerVersion,
  updateAvailableMessage,
  upToDateMessage,
} from "../src/update.ts";

test("parseSemver handles plain, v-prefixed, prerelease, and build metadata", () => {
  expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
  expect(parseSemver("v0.2.0")).toEqual({ major: 0, minor: 2, patch: 0, pre: [] });
  expect(parseSemver("1.0.0-beta.2")).toEqual({ major: 1, minor: 0, patch: 0, pre: ["beta", "2"] });
  expect(parseSemver("1.0.0+build.5")).toEqual({ major: 1, minor: 0, patch: 0, pre: [] });
  expect(parseSemver("not-a-version")).toBeNull();
  expect(parseSemver("1.2")).toBeNull();
});

test("compareSemver orders by major/minor/patch", () => {
  const c = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
  expect(c("1.0.0", "2.0.0")).toBe(-1);
  expect(c("1.2.0", "1.1.0")).toBe(1);
  expect(c("1.1.1", "1.1.1")).toBe(0);
  expect(c("0.2.0", "0.10.0")).toBe(-1); // numeric, not lexicographic
});

test("compareSemver: a release outranks its prerelease", () => {
  const c = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
  expect(c("1.0.0", "1.0.0-beta.1")).toBe(1);
  expect(c("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
  expect(c("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
});

test("isNewerVersion is strict and safe on garbage", () => {
  expect(isNewerVersion("0.2.0", "0.2.1")).toBe(true);
  expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
  expect(isNewerVersion("0.2.1", "0.2.0")).toBe(false);
  expect(isNewerVersion("0.2.0", "1.0.0-beta.1")).toBe(true);
  expect(isNewerVersion("garbage", "0.2.1")).toBe(false);
  expect(isNewerVersion("0.2.0", "")).toBe(false);
});

test("message builders mention the versions", () => {
  expect(updateAvailableMessage("0.2.0", "0.3.0")).toContain("0.3.0");
  expect(updateAvailableMessage("0.2.0", "0.3.0")).toContain("0.2.0");
  expect(upToDateMessage("0.2.0")).toContain("0.2.0");
});
