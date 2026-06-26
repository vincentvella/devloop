/**
 * Device + network emulation presets (pure data) shared by both substrates.
 * The controllers feed these to CDP Emulation.setDeviceMetricsOverride /
 * Network.emulateNetworkConditions.
 */

export interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent: string;
}

export const DEVICE_PRESETS: Record<string, DeviceMetrics> = {
  iphone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  pixel: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  },
};

export interface ThrottleConditions {
  offline: boolean;
  latency: number; // ms
  downloadThroughput: number; // bytes/s, -1 = no limit
  uploadThroughput: number; // bytes/s, -1 = no limit
}

export const THROTTLE: Record<string, ThrottleConditions> = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-3g": { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  "fast-3g": { offline: false, latency: 150, downloadThroughput: 180_000, uploadThroughput: 84_000 },
};
