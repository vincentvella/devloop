/**
 * Wires native (Expo/RN) observability onto the shared timeline.
 *
 * Per pane: a ReactNativeController (JS console/errors/source-maps over Metro's Hermes
 * inspector). Per DEVICE: a single native log stream (simctl os_log / adb logcat) that
 * ROUTES each line to the owning pane's app — by pid (from launch/pidof) or bundle-id
 * mention — or to the shared device/system lane. That's what keeps multiple native panes
 * from each seeing every app's logs. The system lane is opt-in (setSystemView): its lines
 * are captured with no pane target and dropped by default so app logs aren't drowned.
 */
import { execFile } from "node:child_process";
import { AndroidLogStream, adbBinary, captureAdbScreenshot } from "../src/androidLog.ts";
import { captureSimctlScreenshot, type NativeLogLine, NativeLogStream } from "../src/iosSimulator.ts";
import type { LogBuffer } from "../src/logBuffer.ts";
import { adbDriver, idbDriver } from "../src/nativeDriver.ts";
import { type NativeApp, routeNativeLine } from "../src/nativeLogRouter.ts";
import { ReactNativeController } from "../src/reactNativeController.ts";

/** Run `idb <args>` and resolve its stdout — the live interaction/snapshot path for
 *  iOS react-native targets (idb taps/types/swipes + ui describe-all). idb must be on PATH. */
function runIdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("idb", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err)
        reject(
          new Error(
            `idb failed (is idb installed? \`brew install idb-companion\`): ${stderr || (err as Error).message}`.trim(),
          ),
        );
      else resolve(stdout);
    });
  });
}

/** Run `adb <args>` and resolve its stdout — the Android interaction/snapshot path. */
function runAdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adbBinary(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err)
        reject(new Error(`adb failed (is the Android SDK installed?): ${stderr || (err as Error).message}`.trim()));
      else resolve(stdout);
    });
  });
}

interface Attached {
  rn: ReactNativeController;
}

export class NativeObservability {
  private readonly byPane = new Map<string, Attached>();
  /** paneId → app identity (+ current pid) used to route the device log stream. */
  private readonly apps = new Map<string, NativeApp>();
  private iosStream?: NativeLogStream;
  private androidStream?: AndroidLogStream;
  private systemView = false;

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
  attach(opts: {
    paneId: string;
    metroBase: string;
    device: string;
    platform?: "ios" | "android";
    appMatch?: string;
    bundleId?: string;
    pid?: number;
  }): ReactNativeController {
    const existing = this.byPane.get(opts.paneId);
    if (existing) return existing.rn;
    const platform = opts.platform ?? "ios";
    this.log(
      `native observability: pane ${opts.paneId} → ${platform} JS=${opts.metroBase}${opts.bundleId ? ` app=${opts.bundleId}` : ""}`,
    );
    const rn = new ReactNativeController(this.buffer, {
      metroBase: opts.metroBase,
      target: opts.paneId,
      driver: platform === "android" ? adbDriver(opts.device, runAdb) : idbDriver(opts.device, runIdb),
      captureScreenshot: () =>
        platform === "android" ? captureAdbScreenshot(opts.device) : captureSimctlScreenshot(opts.device),
    });
    void rn.start();
    // Register the app for native-log routing + ensure the device's one log stream is up.
    this.trackApp(opts.paneId, { paneId: opts.paneId, bundleId: opts.bundleId, name: opts.appMatch, pid: opts.pid });
    this.ensureDeviceStream(platform, opts.device);
    this.byPane.set(opts.paneId, { rn });
    return rn;
  }

  /** Register/update a pane's app identity (bundle id + current pid) for log routing —
   *  called on attach and again on each app-switch so a swapped-to pane's logs are scoped. */
  trackApp(paneId: string, app: NativeApp): void {
    this.apps.set(paneId, { ...this.apps.get(paneId), ...app, paneId });
  }

  private ensureDeviceStream(platform: "ios" | "android", device: string): void {
    if (platform === "android") {
      if (this.androidStream || process.env.DEVLOOP_NO_ANDROID_LOGCAT) return;
      this.androidStream = new AndroidLogStream({ serial: device, onLine: (l) => this.route(l) });
      this.androidStream.start();
    } else {
      if (this.iosStream) return;
      this.iosStream = new NativeLogStream({ device, onLine: (l) => this.route(l) });
      this.iosStream.start();
    }
  }

  /** Route one captured line to the owning pane, or to the device/system lane. */
  private route(line: NativeLogLine): void {
    const target = routeNativeLine(line, [...this.apps.values()]);
    if (target === null && !this.systemView) return; // drop device/system chatter unless opted in
    this.buffer.push(
      "native",
      line.level,
      line.message,
      line.process ? { process: line.process, pid: line.pid } : undefined,
      target ?? undefined,
    );
  }

  /** Toggle capture of the device/system lane (native logs not attributable to a pane). */
  setSystemView(on: boolean): void {
    this.systemView = on;
    this.log(`native observability: device/system logs ${on ? "on" : "off"}`);
  }

  isSystemView(): boolean {
    return this.systemView;
  }

  detach(paneId: string): void {
    const a = this.byPane.get(paneId);
    if (!a) return;
    this.byPane.delete(paneId);
    this.apps.delete(paneId);
    void a.rn.close();
    // Last native pane gone → tear the shared device streams down.
    if (this.apps.size === 0) {
      this.iosStream?.stop();
      this.iosStream = undefined;
      this.androidStream?.stop();
      this.androidStream = undefined;
    }
    this.log(`native observability: detached pane ${paneId}`);
  }

  detachAll(): void {
    for (const id of [...this.byPane.keys()]) this.detach(id);
  }
}
