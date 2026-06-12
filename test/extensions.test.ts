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
