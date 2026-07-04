import { expect, test } from "bun:test";
import { parseAndroidPidof, parseSimctlLaunchPid, routeNativeLine } from "../src/nativeLogRouter.ts";

const apps = [
  { paneId: "p1", bundleId: "com.acme.one", name: "One", pid: 461 },
  { paneId: "p2", bundleId: "com.acme.two", name: "Two", pid: 502 },
];

test("routeNativeLine: pid match wins", () => {
  expect(routeNativeLine({ pid: 461, process: "One", message: "hi" }, apps)).toBe("p1");
  expect(routeNativeLine({ pid: 502, process: "whatever", message: "y" }, apps)).toBe("p2");
});

test("routeNativeLine: a bundle-id mention from another process routes to that app", () => {
  // e.g. tccd logging a permission decision that names the app's bundle id
  expect(routeNativeLine({ pid: 99, process: "tccd", message: "Prompting for com.acme.two Camera" }, apps)).toBe("p2");
});

test("routeNativeLine: process-name fallback before the pid is known", () => {
  const noPid = [{ paneId: "p1", bundleId: "com.acme.one", name: "One" }];
  expect(routeNativeLine({ pid: 461, process: "One", message: "hi" }, noPid)).toBe("p1");
});

test("routeNativeLine: an unrelated system line → the device/system lane (null)", () => {
  expect(routeNativeLine({ pid: 7, process: "locationd", message: "gps fix" }, apps)).toBeNull();
});

test("parseSimctlLaunchPid + parseAndroidPidof", () => {
  expect(parseSimctlLaunchPid("com.acme.app: 461")).toBe(461);
  expect(parseSimctlLaunchPid("no pid here")).toBeNull();
  expect(parseAndroidPidof("1234 5678")).toBe(1234);
  expect(parseAndroidPidof("\n")).toBeNull();
});
