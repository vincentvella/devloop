import { test, expect } from "bun:test";
import { detectDevCommand, projectName } from "../src/devServer.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const pkgDir = (pkg: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "dl-dev-"));
  writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
  return d;
};

test("detectDevCommand picks by priority dev>develop>web>start>serve", () => {
  expect(detectDevCommand(pkgDir({ scripts: { start: "x", dev: "y" } }))).toBe("bun run dev");
  expect(detectDevCommand(pkgDir({ scripts: { serve: "x", web: "y" } }))).toBe("bun run web");
  expect(detectDevCommand(pkgDir({ scripts: { start: "x" } }))).toBe("bun run start");
});

test("detectDevCommand throws with no package.json or no dev-ish script", () => {
  expect(() => detectDevCommand(mkdtempSync(join(tmpdir(), "dl-empty-")))).toThrow(/no package\.json/);
  expect(() => detectDevCommand(pkgDir({ scripts: { build: "x" } }))).toThrow(/no dev script/);
});

test("projectName uses package.json name, else folder basename", () => {
  expect(projectName(pkgDir({ name: "my-app" }))).toBe("my-app");
  const d = mkdtempSync(join(tmpdir(), "dl-noname-"));
  expect(projectName(d)).toBe(basename(d));
});
