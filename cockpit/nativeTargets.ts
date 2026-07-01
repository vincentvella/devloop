/**
 * Native-target control for the cockpit — iOS simulator + Android device/emulator
 * open/close/mirror, native builds, and native-env probes. Extracted from main.ts
 * as a factory. `getManager`/`getShellWin` are lazy getters because the manager and
 * shell window are assigned during main() boot, after this handle is built.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { usableSerials } from "../src/adb.ts";
import { adbBinary } from "../src/androidLog.ts";
import { AndroidScreenStream, deviceSize } from "../src/androidMirror.ts";
import type { LogBuffer } from "../src/logBuffer.ts";
import { type Platform, resolveNativeInfo } from "../src/nativeBuild.ts";
import { computeFingerprint, runNativeBuild } from "../src/nativeBuildRunner.ts";
import {
  type AndroidBuildProbe,
  type AndroidEnvProbe,
  androidBuildChecks,
  androidBuildReady,
  androidBuildSummary,
  androidEnvChecks,
  androidEnvIssues,
  androidEnvReady,
  androidEnvSummary,
  type NativeEnvProbe,
  nativeEnvChecks,
  nativeEnvIssues,
  nativeEnvReady,
  nativeEnvSummary,
} from "../src/nativeEnv.ts";
import { deriveAppMatch, metroBaseFromUrl } from "../src/nativeObservability.ts";
import { getProjectFingerprint } from "../src/registry.ts";
import { detectTargetKind } from "../src/target.ts";
import type { BrowserManager } from "./browserManager.ts";
import type { NativeObservability } from "./nativeObservability.ts";
import type { ServeSim } from "./serveSim.ts";

export interface NativeTargetsDeps {
  getManager: () => BrowserManager;
  getShellWin: () => BrowserWindow | undefined;
  serveSim: ServeSim;
  observability: NativeObservability;
  buffer: LogBuffer;
  log: (m: string) => void;
}

export type NativeTargets = ReturnType<typeof createNativeTargets>;

export function createNativeTargets(deps: NativeTargetsDeps) {
  const { getManager, getShellWin, serveSim, observability, buffer, log } = deps;

  /** Probe native-interaction readiness (idb CLI + companion + a booted sim). */
  function probeNativeEnv(): NativeEnvProbe {
    const has = (cmd: string): boolean => {
      try {
        execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    let bootedSim = false;
    try {
      bootedSim = /Booted/.test(
        execFileSync("xcrun", ["simctl", "list", "devices", "booted"], { encoding: "utf8", timeout: 5000 }),
      );
    } catch {
      /* no xcrun / Xcode */
    }
    return { idb: has("idb"), idbCompanion: has("idb_companion"), bootedSim };
  }

  /** Run `adb <args>` → stdout (async). adb is resolved via the SDK if not on PATH. */
  function runAdb(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(adbBinary(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || (err as Error).message)) : resolve(stdout),
      );
    });
  }

  /** Probe Android-interaction readiness: adb present + at least one usable device. */
  function probeAndroidEnv(): AndroidEnvProbe {
    let adbOk = false;
    let serials: string[] = [];
    try {
      const out = execFileSync(adbBinary(), ["devices"], { encoding: "utf8", timeout: 5000 });
      adbOk = true;
      serials = usableSerials(out);
    } catch {
      /* no adb / SDK */
    }
    return { adb: adbOk, bootedDevice: serials.length > 0 };
  }

  /** Probe the Android BUILD toolchain (for a local `expo run:android`): a
   *  discoverable SDK (`$ANDROID_HOME`), its platform-tools (`adb`), and a JDK. */
  function probeAndroidBuild(): AndroidBuildProbe {
    const onPath = (cmd: string): boolean => {
      try {
        execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    let adb = false;
    try {
      execFileSync(adbBinary(), ["--version"], { stdio: "ignore", timeout: 5000 });
      adb = true;
    } catch {
      /* no adb / SDK platform-tools */
    }
    return { adb, jdk: onPath("java"), androidHome: !!(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) };
  }

  /** First usable Android serial, or null. */
  function firstAndroidSerial(): string | null {
    try {
      return usableSerials(execFileSync(adbBinary(), ["devices"], { encoding: "utf8", timeout: 5000 }))[0] ?? null;
    } catch {
      return null;
    }
  }

  let androidStream: AndroidScreenStream | undefined;

  // --- native target control (shared by the renderer IPCs + the native_* MCP tools) ---

  async function doOpenSimulator(): Promise<{ ok: boolean; summary?: string }> {
    const info = await serveSim.ensure(); // serve-sim captures the booted iOS sim as an interactive MJPEG preview
    if (!info) {
      log("simulator: serve-sim has no booted device (boot a simulator first)");
      return { ok: false, summary: "no booted iOS simulator (boot one in Simulator.app)" };
    }
    await getManager().setSimulatorActive(true, info);
    const active = getManager()
      .listPanes()
      .find((p) => p.active);
    // Preflight: native taps/snapshot need idb + companion + a booted sim — surface gaps on the timeline.
    const issues = nativeEnvIssues(probeNativeEnv());
    if (issues.length) {
      log(`native env: ${nativeEnvSummary(probeNativeEnv())}`);
      buffer.push(
        "native",
        "log",
        `⚠ native interactions unavailable — ${issues.map((i) => `${i.what} → ${i.fix}`).join("; ")}`,
        undefined,
        active?.id,
      );
    }
    const metroBase = metroBaseFromUrl(active?.url);
    if (active && metroBase) {
      const rn = observability.attach({
        paneId: active.id,
        metroBase,
        device: "booted",
        appMatch: active.dev?.cwd ? appMatchFor(active.dev.cwd) : undefined,
      });
      getManager().setNativeController(active.id, rn); // browser_* → the RN/idb controller while iOS is active
    } else {
      log("simulator: no Metro URL on the active pane — start its bundler to stream JS logs");
    }
    return { ok: true };
  }

  async function doCloseSimulator(): Promise<void> {
    await getManager().setSimulatorActive(false); // browser_* route back to the web pane
    observability.detachAll();
    const active = getManager()
      .listPanes()
      .find((p) => p.active);
    if (active) getManager().setNativeController(active.id, undefined);
  }

  async function doOpenAndroid(): Promise<{ ok: boolean; summary?: string; serial?: string }> {
    const probe = probeAndroidEnv();
    const issues = androidEnvIssues(probe);
    const active = getManager()
      .listPanes()
      .find((p) => p.active);
    if (issues.length) {
      log(`android env: ${androidEnvSummary(probe)}`);
      buffer.push(
        "native",
        "log",
        `⚠ Android interactions unavailable — ${issues.map((i) => `${i.what} → ${i.fix}`).join("; ")}`,
        undefined,
        active?.id,
      );
      if (!probe.adb || !probe.bootedDevice) return { ok: false, summary: androidEnvSummary(probe) };
    }
    const serial = firstAndroidSerial();
    if (!serial) return { ok: false, summary: "no usable Android device" };
    const metroBase = metroBaseFromUrl(active?.url);
    if (active) {
      // With Metro → JS over CDP too; without → still mirror + allow taps.
      const rn = observability.attach({
        paneId: active.id,
        metroBase: metroBase || "http://localhost:8081",
        device: serial,
        platform: "android",
      });
      getManager().setNativeController(active.id, rn);
    }
    getManager().setAndroidActive(true);
    const size = await deviceSize(serial).catch(() => null);
    getShellWin()?.webContents.send("devloop:androidSize", size ?? { width: 1080, height: 2400 });
    androidStream?.stop();
    if (!process.env.DEVLOOP_NO_ANDROID_STREAM) {
      androidStream = new AndroidScreenStream({
        serial,
        onFrame: (b64) => getShellWin()?.webContents.send("devloop:androidFrame", b64),
      });
      androidStream.start();
    }
    log(`android: mirroring ${serial}${metroBase ? ` (JS=${metroBase})` : ""}`);
    return { ok: true, serial };
  }

  async function doCloseAndroid(): Promise<void> {
    androidStream?.stop();
    androidStream = undefined;
    getManager().setAndroidActive(false);
    observability.detachAll();
    const active = getManager()
      .listPanes()
      .find((p) => p.active);
    if (active) getManager().setNativeController(active.id, undefined);
  }

  /** Re-probe all native readiness (iOS + Android interactions + Android build) — no build/open. */
  function doctor() {
    const ios = probeNativeEnv();
    const ai = probeAndroidEnv();
    const ab = probeAndroidBuild();
    return {
      ios: { ready: nativeEnvReady(ios), checks: nativeEnvChecks(ios), summary: nativeEnvSummary(ios) },
      androidInteractions: { ready: androidEnvReady(ai), checks: androidEnvChecks(ai), summary: androidEnvSummary(ai) },
      androidBuild: { ready: androidBuildReady(ab), checks: androidBuildChecks(ab), summary: androidBuildSummary(ab) },
    };
  }

  function doNativeBuild(platform: Platform, cwd?: string): { started: boolean; detail?: string } {
    const active = getManager()
      .listPanes()
      .find((p) => p.active);
    const root = cwd || active?.dev?.cwd;
    if (!root || !platform) return { started: false, detail: "no project cwd — set the pane's project or pass cwd" };
    // Local-first: if the Android toolchain isn't set up, don't spawn a doomed build —
    // return the doctor's checklist of exactly what to install.
    if (platform === "android") {
      const probe = probeAndroidBuild();
      if (!androidBuildReady(probe)) return { started: false, detail: androidBuildSummary(probe) };
    }
    // streams to the timeline; records a fingerprint on success.
    runNativeBuild({ buffer, projectRoot: root, platform });
    return { started: true, detail: `building ${platform} in ${root}` };
  }

  /** Best-effort native-log process match from a project's Expo config. */
  function appMatchFor(cwd: string): string {
    let cfg: { name?: string; expo?: { name?: string } } | null = null;
    try {
      cfg = JSON.parse(readFileSync(join(cwd, "app.json"), "utf8"));
    } catch {
      /* app.config.ts or none → fall back to dir name */
    }
    return deriveAppMatch(cfg, cwd);
  }

  /**
   * Probe a project dir for native-build info (is it Expo/RN, which platforms,
   * is the installed binary stale). Composes the pure resolveNativeInfo with fs +
   * fingerprint reads. Fingerprint compute is ~1s; called when the wrench opens.
   */
  async function nativeInfo(cwd: string) {
    if (!cwd || !existsSync(cwd)) return { isNative: false, platforms: [], buildStatus: "unknown", badge: null };
    let deps: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      /* no package.json → web */
    }
    const probe = { hasIosDir: existsSync(join(cwd, "ios")), hasAndroidDir: existsSync(join(cwd, "android")) };
    const kind = detectTargetKind({ dependencies: deps, ...probe });
    if (kind !== "react-native")
      return { isNative: false, platforms: [], targets: [], buildStatus: "unknown", badge: null };
    const webCapable = !!(deps["expo"] || deps["react-native-web"]); // Expo / RNW → has a Web target
    const iosCapable = process.platform === "darwin"; // iOS simulator + idb are macOS-only
    const current = await computeFingerprint(cwd);
    return resolveNativeInfo(kind, probe, current, getProjectFingerprint(cwd), webCapable, iosCapable);
  }

  return {
    doOpenSimulator,
    doCloseSimulator,
    doOpenAndroid,
    doCloseAndroid,
    doNativeBuild,
    doctor,
    probeNativeEnv,
    probeAndroidEnv,
    probeAndroidBuild,
    firstAndroidSerial,
    runAdb,
    appMatchFor,
    nativeInfo,
  };
}
