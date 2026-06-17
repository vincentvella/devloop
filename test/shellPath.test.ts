import { expect, test } from "bun:test";
import { mergePath, parseShellPath } from "../src/shellPath.ts";

test("mergePath puts shell entries first, dedupes, keeps current extras", () => {
  expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  expect(mergePath(undefined, "/a:/b")).toBe("/a:/b");
  expect(mergePath("/a:/b", undefined)).toBe("/a:/b");
  expect(mergePath("", "")).toBe("");
});

test("mergePath trims + drops empty segments", () => {
  expect(mergePath("/bin: ", "/a::/b ")).toBe("/a:/b:/bin");
});

test("parseShellPath extracts the PATH after the marker", () => {
  expect(parseShellPath("noise\n__DL__/opt/homebrew/bin:/usr/bin", "__DL__")).toBe("/opt/homebrew/bin:/usr/bin");
  expect(parseShellPath("__DL__  /a:/b  ", "__DL__")).toBe("/a:/b");
  expect(parseShellPath("no marker here", "__DL__")).toBeNull();
  expect(parseShellPath("__DL__", "__DL__")).toBeNull();
});
