import { expect, test } from "bun:test";
import { advertisedUrl, daemonConfigFromEnv, numEnv, shouldScheduleIdleShutdown } from "../src/daemonConfig.ts";

// --- numEnv ------------------------------------------------------------------

test("numEnv: parses a number, falls back on missing/empty/non-numeric (the NaN guard)", () => {
  expect(numEnv("8080", 7333)).toBe(8080);
  expect(numEnv(undefined, 7333)).toBe(7333);
  expect(numEnv("", 7333)).toBe(7333);
  expect(numEnv("abc", 7333)).toBe(7333); // was: Number("abc") → NaN silently propagated
  expect(numEnv("0", 7333)).toBe(0); // a real 0 is honored, not treated as falsy
});

// --- daemonConfigFromEnv -----------------------------------------------------

test("daemonConfigFromEnv: empty env yields all defaults", () => {
  const c = daemonConfigFromEnv({});
  expect(c).toEqual({
    logCapacity: 5000,
    headless: true,
    chromePath: undefined,
    netThreshold: 400,
    actionTimeoutMs: 10_000,
    navTimeoutMs: 30_000,
    port: 7333,
    idleMs: 0,
    host: "127.0.0.1",
    devCmd: undefined,
    devCwd: undefined,
  });
});

test("daemonConfigFromEnv: reads overrides and honors DEVLOOP_HEADLESS=false", () => {
  const c = daemonConfigFromEnv({
    DEVLOOP_LOG_CAPACITY: "100",
    DEVLOOP_HEADLESS: "false",
    DEVLOOP_CHROME_PATH: "/opt/chrome",
    DEVLOOP_NET_THRESHOLD: "500",
    DEVLOOP_HTTP_PORT: "9000",
    DEVLOOP_DAEMON_IDLE_MS: "60000",
    DEVLOOP_HTTP_HOST: "0.0.0.0",
    DEVLOOP_DEV_CMD: "bun run dev",
    DEVLOOP_DEV_CWD: "/proj",
  });
  expect(c.logCapacity).toBe(100);
  expect(c.headless).toBe(false);
  expect(c.chromePath).toBe("/opt/chrome");
  expect(c.netThreshold).toBe(500);
  expect(c.port).toBe(9000);
  expect(c.idleMs).toBe(60_000);
  expect(c.host).toBe("0.0.0.0");
  expect(c.devCmd).toBe("bun run dev");
  expect(c.devCwd).toBe("/proj");
});

test("daemonConfigFromEnv: a typo'd numeric env falls back instead of poisoning the daemon with NaN", () => {
  const c = daemonConfigFromEnv({ DEVLOOP_HTTP_PORT: "not-a-port" });
  expect(c.port).toBe(7333);
  expect(Number.isNaN(c.port)).toBe(false);
});

test("daemonConfigFromEnv: only DEVLOOP_HEADLESS=false disables headless; anything else stays headless", () => {
  expect(daemonConfigFromEnv({ DEVLOOP_HEADLESS: "true" }).headless).toBe(true);
  expect(daemonConfigFromEnv({ DEVLOOP_HEADLESS: "0" }).headless).toBe(true); // not "false" → still headless
  expect(daemonConfigFromEnv({ DEVLOOP_HEADLESS: "false" }).headless).toBe(false);
});

// --- advertisedUrl -----------------------------------------------------------

test("advertisedUrl: 0.0.0.0 (a bind address, unreachable) is advertised as localhost", () => {
  expect(advertisedUrl("127.0.0.1", 7333)).toBe("http://127.0.0.1:7333/mcp");
  expect(advertisedUrl("0.0.0.0", 9000)).toBe("http://localhost:9000/mcp");
  expect(advertisedUrl("192.168.1.5", 7333)).toBe("http://192.168.1.5:7333/mcp");
});

// --- shouldScheduleIdleShutdown ----------------------------------------------

test("shouldScheduleIdleShutdown: only when enabled (idleMs>0) AND no clients remain", () => {
  expect(shouldScheduleIdleShutdown(60_000, 0)).toBe(true);
  expect(shouldScheduleIdleShutdown(60_000, 1)).toBe(false); // clients still connected
  expect(shouldScheduleIdleShutdown(0, 0)).toBe(false); // idle-shutdown disabled
  expect(shouldScheduleIdleShutdown(0, 1)).toBe(false);
});
