/**
 * Wires a native (Expo/RN) target's observability onto the shared timeline:
 * a ReactNativeController (JS console/errors/source-maps over Metro's Hermes
 * inspector) + a NativeLogStream (simctl native/os_log), both tagged with the
 * pane id so get_logs can scope by app. One attachment per pane.
 */
import { execFile } from "node:child_process";
import type { LogBuffer } from "../src/logBuffer.ts";
import { ReactNativeController } from "../src/reactNativeController.ts";
import { NativeLogStream, captureSimctlScreenshot } from "../src/iosSimulator.ts";
import { AndroidLogStream, captureAdbScreenshot, adbBinary } from "../src/androidLog.ts";
import { idbDriver, adbDriver } from "../src/nativeDriver.ts";

/** Run `idb <args>` and resolve its stdout — the live interaction/snapshot path for
 *  iOS react-native targets (idb taps/types/swipes + ui describe-all). idb must be on PATH. */
function runIdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("idb", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`idb failed (is idb installed? \`brew install idb-companion\`): ${stderr || (err as Error).message}`.trim()));
      else resolve(stdout);
    });
  });
}

/** Run `adb <args>` and resolve its stdout — the Android interaction/snapshot path. */
function runAdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adbBinary(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`adb failed (is the Android SDK installed?): ${stderr || (err as Error).message}`.trim()));
      else resolve(stdout);
    });
  });
}

interface Attached {
  rn: ReactNativeController;
  native?: NativeLogStream | AndroidLogStream;
}

export class NativeObservability {
  private readonly byPane = new Map<string, Attached>();

  constructor(
    private readonly buffer: LogBuffer,
    private readonly log: (m: string) => void,
  ) {}

  isAttached(paneId: string): boolean {
    return this.byPane.has(paneId);
  }

  /** Start streaming JS + native logs for a pane; returns the RN controller (so it can
   *  be wired as the pane's native target for browser_*). Returns the existing one if
   *  already attached. */
  attach(opts: { paneId: string; metroBase: string; device: string; platform?: "ios" | "android"; appMatch?: string }): ReactNativeController {
    const existing = this.byPane.get(opts.paneId);
    if (existing) return existing.rn;
    const platform = opts.platform ?? "ios";
    this.log(`native observability: pane ${opts.paneId} → ${platform} JS=${opts.metroBase}${opts.appMatch ? ` native~"${opts.appMatch}"` : ""}`);
    const rn = new ReactNativeController(this.buffer, {
      metroBase: opts.metroBase,
      target: opts.paneId,
      driver: platform === "android" ? adbDriver(opts.device, runAdb) : idbDriver(opts.device, runIdb),
      captureScreenshot: () => (platform === "android" ? captureAdbScreenshot(opts.device) : captureSimctlScreenshot(opts.device)),
    });
    void rn.start();
    let native: NativeLogStream | AndroidLogStream | undefined;
    if (platform === "android") {
      if (!process.env.DEVLOOP_NO_ANDROID_LOGCAT) {
        native = new AndroidLogStream(this.buffer, { serial: opts.device, target: opts.paneId });
        native.start();
      }
    } else if (opts.appMatch) {
      native = new NativeLogStream(this.buffer, { device: opts.device, match: opts.appMatch, target: opts.paneId });
      native.start();
    }
    this.byPane.set(opts.paneId, { rn, native });
    return rn;
  }

  detach(paneId: string): void {
    const a = this.byPane.get(paneId);
    if (!a) return;
    this.byPane.delete(paneId);
    void a.rn.close();
    a.native?.stop();
    this.log(`native observability: detached pane ${paneId}`);
  }

  detachAll(): void {
    for (const id of [...this.byPane.keys()]) this.detach(id);
  }
}
