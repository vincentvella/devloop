/**
 * Pure logic for native (Expo/RN) builds — kept dependency-free so it unit-tests
 * without a toolchain. The build runner + fingerprint computation (which shell
 * out to the project's Expo/`@expo/fingerprint`) live in nativeBuildRunner.ts.
 *
 * Why this exists: unlike web, a native project has two build artifacts that can
 * drift — the JS bundle (Metro) and the compiled binary (.app/.apk). When native
 * inputs change (a new native module, config plugin), the installed binary is
 * stale and the app red-screens. We detect that and offer a rebuild.
 */

export type Platform = "ios" | "android";

export interface NativeProbe {
  hasIosDir?: boolean;
  hasAndroidDir?: boolean;
}

/** Platforms a project can build for, from its prebuilt native dirs. iOS first. */
export function availablePlatforms(probe: NativeProbe): Platform[] {
  const out: Platform[] = [];
  if (probe.hasIosDir) out.push("ios");
  if (probe.hasAndroidDir) out.push("android");
  return out;
}

export type PackageManager = "bun" | "npm";

/** The command to build + install + launch a dev build for a platform. */
export function buildCommand(platform: Platform, opts: { packageManager?: PackageManager } = {}): { cmd: string; args: string[] } {
  const runner = opts.packageManager === "npm" ? "npx" : "bunx";
  return { cmd: runner, args: ["expo", `run:${platform}`] };
}

export type FingerprintStatus = "fresh" | "stale" | "unknown";

/**
 * Compare the project's current native fingerprint against the one recorded when
 * Devloop last built it. `unknown` when either is missing (e.g. built outside
 * Devloop, or fingerprint couldn't be computed) — we offer a build but don't
 * claim staleness without a baseline.
 */
export function fingerprintStatus(current?: string | null, recorded?: string | null): FingerprintStatus {
  if (!current || !recorded) return "unknown";
  return current === recorded ? "fresh" : "stale";
}

/** Short UI label for a build status badge. null when nothing to show. */
export function buildStatusLabel(status: FingerprintStatus): string | null {
  if (status === "stale") return "rebuild recommended";
  if (status === "unknown") return "build status unknown";
  return null; // fresh — no badge
}

export interface NativeInfo {
  isNative: boolean;
  platforms: Platform[];
  buildStatus: FingerprintStatus;
  badge: string | null;
}

/**
 * What the cockpit needs to render the build control for a project: whether it's
 * a native target, which platforms to offer, and the staleness badge. Pure — the
 * cockpit feeds it the detected kind + fs probe + fingerprints.
 *
 * Offers iOS even with no prebuilt `ios/` dir, since `expo run:ios` prebuilds on
 * first run; existing native dirs just mean a faster incremental build.
 */
export function resolveNativeInfo(
  kind: "web" | "react-native",
  probe: NativeProbe,
  currentFingerprint?: string | null,
  recordedFingerprint?: string | null,
): NativeInfo {
  if (kind !== "react-native") return { isNative: false, platforms: [], buildStatus: "unknown", badge: null };
  const dirs = availablePlatforms(probe);
  const platforms: Platform[] = dirs.length ? dirs : ["ios"];
  const buildStatus = fingerprintStatus(currentFingerprint, recordedFingerprint);
  return { isNative: true, platforms, buildStatus, badge: buildStatusLabel(buildStatus) };
}
