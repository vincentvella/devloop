/**
 * Route a parsed native log line to the pane whose app produced it, or to the shared
 * device/system lane. With one booted device shared across native panes, a single log
 * stream (os_log / logcat) captures everything; this decides who each line belongs to.
 *
 * Pure — the live capture + buffer.push live in cockpit/nativeObservability.ts.
 */
import type { NativeLogLine } from "./iosSimulator.ts";

export interface NativeApp {
  paneId: string;
  /** Bundle id (iOS) / package (Android) — from appIdentity. Matches cross-process
   *  system logs that name the app (e.g. a permission denial from tccd). */
  bundleId?: string;
  /** The app's process name (os_log) — a fallback match before its pid is known. */
  name?: string;
  /** The app's current OS pid (from launch / pidof) — the reliable, primary match. */
  pid?: number;
}

/**
 * The paneId a line belongs to, or null for the device/system lane. Precedence:
 *   1. pid == the app's launched pid — the app's own process (reliable).
 *   2. the app's bundle id appears in the message — system services naming the app.
 *   3. the line's process == the app's process name — the app before we have its pid.
 */
export function routeNativeLine(
  line: Pick<NativeLogLine, "pid" | "process" | "message">,
  apps: readonly NativeApp[],
): string | null {
  for (const app of apps) {
    if (app.pid != null && line.pid === app.pid) return app.paneId;
  }
  for (const app of apps) {
    if (app.bundleId && line.message.includes(app.bundleId)) return app.paneId;
    if (app.name && line.process && line.process === app.name) return app.paneId;
  }
  return null;
}

/** PID from `xcrun simctl launch booted <id>` output (e.g. "com.acme.app: 461"). */
export function parseSimctlLaunchPid(stdout: string): number | null {
  const m = stdout.match(/:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/** PID from `adb shell pidof <package>` (space-separated pids — take the first). */
export function parseAndroidPidof(stdout: string): number | null {
  const m = stdout.trim().match(/^\d+/);
  return m ? Number(m[0]) : null;
}
