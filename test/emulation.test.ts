import { expect, test } from "bun:test";
import { DEVICE_PRESETS, THROTTLE } from "../src/emulation.ts";

test("device presets have sane mobile metrics", () => {
  for (const name of ["iphone", "ipad", "pixel"]) {
    const d = DEVICE_PRESETS[name];
    expect(d).toBeDefined();
    expect(d!.width).toBeGreaterThan(0);
    expect(d!.height).toBeGreaterThan(0);
    expect(d!.deviceScaleFactor).toBeGreaterThan(0);
    expect(d!.mobile).toBe(true);
    expect(typeof d!.userAgent).toBe("string");
  }
  expect(DEVICE_PRESETS.iphone!.width).toBe(390);
});

test("throttle profiles map to CDP conditions", () => {
  expect(THROTTLE.offline).toMatchObject({ offline: true });
  expect(THROTTLE.none).toMatchObject({ offline: false, downloadThroughput: -1, latency: 0 });
  const slow = THROTTLE["slow-3g"]!;
  expect(slow.offline).toBe(false);
  expect(slow.downloadThroughput).toBeGreaterThan(0);
  expect(slow.latency).toBeGreaterThan(0);
  expect(THROTTLE["fast-3g"]!.downloadThroughput).toBeGreaterThan(slow.downloadThroughput);
});
