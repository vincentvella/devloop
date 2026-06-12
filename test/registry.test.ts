import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// registry reads DEVLOOP_HOME at module load — set it before importing.
const dir = mkdtempSync(join(tmpdir(), "dl-reg-"));
process.env.DEVLOOP_HOME = dir;
const reg = await import("../src/registry.ts");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("projects: add / get / list (sorted) / replace / remove", () => {
  expect(reg.listProjects()).toEqual([]);
  reg.addProject({ name: "b", cwd: "/b" });
  reg.addProject({ name: "a", cwd: "/a", cmd: "bun run dev" });
  expect(reg.listProjects().map((p) => p.name)).toEqual(["a", "b"]); // sorted by name
  expect(reg.getProject("a")?.cmd).toBe("bun run dev");

  reg.addProject({ name: "a", cwd: "/a2" }); // replace by name
  expect(reg.listProjects().filter((p) => p.name === "a").length).toBe(1);
  expect(reg.getProject("a")?.cwd).toBe("/a2");

  reg.removeProject("a");
  expect(reg.getProject("a")).toBeUndefined();
  expect(reg.listProjects().map((p) => p.name)).toEqual(["b"]);
});

test("addProject requires name and cwd", () => {
  expect(() => reg.addProject({ name: "", cwd: "/x" })).toThrow();
  expect(() => reg.addProject({ name: "x", cwd: "" })).toThrow();
});

test("session round-trips", () => {
  expect(reg.getSession()).toEqual({});
  reg.setSession({ url: "http://x", project: "p", steps: [{ kind: "navigate", url: "u" }] });
  const s = reg.getSession();
  expect(s.project).toBe("p");
  expect(s.steps?.[0]?.url).toBe("u");
});

test("panes round-trip with a safe default", () => {
  expect(reg.getPanes()).toEqual({ panes: [] });
  reg.setPanes({ panes: [{ url: "u", label: "l", cwd: "/c" }], activeIndex: 0 });
  expect(reg.getPanes().panes.length).toBe(1);
  expect(reg.getPanes().activeIndex).toBe(0);
});

test("unpacked extensions round-trip + dedupe", () => {
  expect(reg.getUnpackedExtensions()).toEqual([]);
  reg.setUnpackedExtensions(["/a", "/b", "/a"]);
  expect(reg.getUnpackedExtensions()).toEqual(["/a", "/b"]);
});
