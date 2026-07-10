import { expect, test } from "bun:test";
import { keyToAction, prettyAccel, SHORTCUTS } from "../src/shortcuts.ts";

test("keyToAction maps keys (r honors shift for hard reload)", () => {
  expect(keyToAction("l", false)).toBe("focusUrl");
  expect(keyToAction("f", false)).toBe("focusFilter");
  expect(keyToAction("r", false)).toBe("reload");
  expect(keyToAction("r", true)).toBe("hardReload");
  expect(keyToAction("/", false)).toBe("cheatsheet");
  expect(keyToAction("z", false)).toBeUndefined();
});

test("prettyAccel renders mac glyphs / cross-platform text", () => {
  expect(prettyAccel("CmdOrCtrl+Shift+R")).toBe("⌘⇧R");
  expect(prettyAccel("CmdOrCtrl+/")).toBe("⌘/");
  expect(prettyAccel("CmdOrCtrl+K", false)).toBe("Ctrl+K");
});

test("every SHORTCUTS accel is renderable and every id is unique", () => {
  const ids = new Set<string>();
  for (const s of SHORTCUTS) {
    expect(s.accel).toContain("CmdOrCtrl");
    expect(prettyAccel(s.accel).length).toBeGreaterThan(0);
    expect(ids.has(s.id)).toBe(false);
    ids.add(s.id);
  }
});
