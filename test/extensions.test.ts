import { test, expect } from "bun:test";
import { extensionIdFromInput } from "../src/extensions.ts";

test("extensionIdFromInput accepts a raw id", () => {
  expect(extensionIdFromInput("fmkadmapgofadopljbjfkapdkoienihi")).toBe("fmkadmapgofadopljbjfkapdkoienihi");
  expect(extensionIdFromInput("  fmkadmapgofadopljbjfkapdkoienihi  ")).toBe("fmkadmapgofadopljbjfkapdkoienihi");
});

test("extensionIdFromInput extracts the id from a Web Store URL", () => {
  expect(extensionIdFromInput("https://chromewebstore.google.com/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi")).toBe("fmkadmapgofadopljbjfkapdkoienihi");
  expect(extensionIdFromInput("https://chromewebstore.google.com/detail/fmkadmapgofadopljbjfkapdkoienihi?hl=en")).toBe("fmkadmapgofadopljbjfkapdkoienihi");
});

test("extensionIdFromInput rejects non-ids", () => {
  expect(extensionIdFromInput("not an id")).toBeNull();
  expect(extensionIdFromInput("ABCDEF")).toBeNull();
  expect(extensionIdFromInput("https://example.com/")).toBeNull();
  expect(extensionIdFromInput("zzzz")).toBeNull(); // z is outside a-p
});

import { unifyExtensions } from "../src/extensions.ts";

test("unifyExtensions: loaded→enabled, disabled→disabled, sorted, loaded wins dupes", () => {
  const loaded = [{ id: "b", name: "Beta", version: "1" }];
  const disabled = [
    { id: "a", name: "Alpha", version: "2" },
    { id: "b", name: "BetaStale", version: "0" }, // dupe id → loaded wins
  ];
  expect(unifyExtensions(loaded, disabled)).toEqual([
    { id: "a", name: "Alpha", version: "2", enabled: false },
    { id: "b", name: "Beta", version: "1", enabled: true },
  ]);
});

test("unifyExtensions: empties", () => {
  expect(unifyExtensions([], [])).toEqual([]);
  expect(unifyExtensions([{ id: "x", name: "X", version: "1" }], [])).toEqual([{ id: "x", name: "X", version: "1", enabled: true }]);
});
