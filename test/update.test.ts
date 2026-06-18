import { expect, test } from "bun:test";
import {
  parseSemver,
  compareSemver,
  isNewerVersion,
  updateAvailableMessage,
  upToDateMessage,
  formatBytesPerSec,
  updateStatusLabel,
} from "../src/update.ts";

test("formatBytesPerSec scales B/KB/MB and drops missing/zero", () => {
  expect(formatBytesPerSec(undefined)).toBe("");
  expect(formatBytesPerSec(0)).toBe("");
  expect(formatBytesPerSec(500)).toBe("500 B/s");
  expect(formatBytesPerSec(2048)).toBe("2.0 KB/s");
  expect(formatBytesPerSec(1258291)).toBe("1.2 MB/s");
});

test("updateStatusLabel renders each state (empty when idle)", () => {
  expect(updateStatusLabel({ state: "idle" })).toBe("");
  expect(updateStatusLabel({ state: "checking" })).toBe("Checking for updates…");
  expect(updateStatusLabel({ state: "available", version: "0.3.5" })).toBe("Devloop 0.3.5 available");
  expect(updateStatusLabel({ state: "downloading", version: "0.3.5", percent: 42.4, bytesPerSecond: 1258291 })).toBe("Downloading 0.3.5… 42% · 1.2 MB/s");
  expect(updateStatusLabel({ state: "downloading", version: "0.3.5", percent: 7 })).toBe("Downloading 0.3.5… 7%");
  expect(updateStatusLabel({ state: "downloaded", version: "0.3.5" })).toBe("Devloop 0.3.5 ready — restart to install");
  expect(updateStatusLabel({ state: "uptodate", version: "0.3.4" })).toBe("You're up to date");
  expect(updateStatusLabel({ state: "error", message: "network down" })).toBe("Update failed: network down");
});

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
