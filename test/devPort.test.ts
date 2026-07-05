import { expect, test } from "bun:test";
import { assignMetroPort, hasExplicitPort, resolveScript, usesMetro, withMetroPort } from "../src/devPort.ts";

const scripts: Record<string, string> = {
  web: "expo start --web",
  dev: "vite",
  start: "react-native start",
  pinned: "expo start --web --port 8090",
};

test("resolveScript expands a runner script, passes a direct command through", () => {
  expect(resolveScript("bun run web", scripts)).toBe("expo start --web");
  expect(resolveScript("node server.mjs", scripts)).toBe("node server.mjs");
});

test("usesMetro detects expo/metro/react-native start (direct + via script)", () => {
  expect(usesMetro("bun run web", scripts)).toBe(true);
  expect(usesMetro("expo start --web", {})).toBe(true);
  expect(usesMetro("bun run start", scripts)).toBe(true); // react-native start
  expect(usesMetro("bun run dev", scripts)).toBe(false); // vite
  expect(usesMetro("node server.mjs", {})).toBe(false);
});

test("hasExplicitPort respects an already-pinned port", () => {
  expect(hasExplicitPort("bun run pinned", scripts)).toBe(true);
  expect(hasExplicitPort("expo start --port 9000", {})).toBe(true);
  expect(hasExplicitPort("expo start -p 9000", {})).toBe(true);
  expect(hasExplicitPort("bun run web", scripts)).toBe(false);
});

test("withMetroPort forwards through a runner, else appends directly", () => {
  expect(withMetroPort("bun run web", 8082)).toBe("bun run web -- --port 8082");
  expect(withMetroPort("expo start --web", 8082)).toBe("expo start --web --port 8082");
});

test("assignMetroPort leaves non-metro / already-pinned commands untouched", async () => {
  expect((await assignMetroPort("bun run dev", scripts)).cmd).toBe("bun run dev");
  expect((await assignMetroPort("bun run pinned", scripts)).cmd).toBe("bun run pinned");
});

test("assignMetroPort pins a free port for a metro command", async () => {
  const r = await assignMetroPort("bun run web", scripts);
  expect(r.cmd).toMatch(/ -- --port \d+$/);
  expect(r.port).toBeGreaterThanOrEqual(8081);
});
