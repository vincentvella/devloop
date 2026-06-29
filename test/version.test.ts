import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { VERSION } from "../src/version.ts";

describe("VERSION", () => {
  test("is sourced from package.json (guards against hardcoded drift)", () => {
    expect(VERSION).toBe(pkg.version);
  });

  test("is a real semver, not a stale literal", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe("0.5.2");
    expect(VERSION).not.toBe("0.6.0");
  });
});
