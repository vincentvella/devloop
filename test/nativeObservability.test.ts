import { expect, test } from "bun:test";
import { metroBaseFromUrl, deriveAppMatch } from "../src/nativeObservability.ts";

test("metroBaseFromUrl returns the local origin (with port), else null", () => {
  expect(metroBaseFromUrl("http://localhost:8082/some/path")).toBe("http://localhost:8082");
  expect(metroBaseFromUrl("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
  expect(metroBaseFromUrl("https://example.com")).toBeNull(); // not local
  expect(metroBaseFromUrl("about:blank")).toBeNull();
  expect(metroBaseFromUrl(undefined)).toBeNull();
  expect(metroBaseFromUrl("")).toBeNull();
});

test("deriveAppMatch prefers Expo config name, else capitalized basename", () => {
  expect(deriveAppMatch({ expo: { name: "Caliburr" } }, "/x/caliburr")).toBe("Caliburr");
  expect(deriveAppMatch({ name: "MyApp" }, "/x/whatever")).toBe("MyApp");
  expect(deriveAppMatch(null, "/Users/vince/Workspace/caliburr")).toBe("Caliburr");
  expect(deriveAppMatch(null, "/x/bonfire/")).toBe("Bonfire");
  expect(deriveAppMatch({}, "")).toBe(""); // no name, no path → empty
});
