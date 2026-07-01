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

/**
 * The command to build + install a dev build for a platform: `expo run:<platform>`
 * (needs the local toolchain — Xcode for iOS, Android SDK + JDK for Android).
 * Devloop is local-first: there's no cloud-build path — a missing toolchain is
 * diagnosed by the readiness doctor (see nativeEnv.ts) so the user can fix it.
 */
export function buildCommand(
  platform: Platform,
  opts: { packageManager?: PackageManager } = {},
): { cmd: string; args: string[] } {
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

/** A view target the cockpit can switch between for an Expo project. Web is the
 * Metro web bundle (a normal browser pane); iOS is the simulator; Android is the
 * adb-driven device mirror. */
export type ViewTarget = "web" | "ios" | "android";

export interface NativeInfo {
  isNative: boolean;
  /** Platforms a native build targets (ios/android). */
  platforms: Platform[];
  /** View targets to offer in the switcher (web + ios + android). */
  targets: ViewTarget[];
  buildStatus: FingerprintStatus;
  badge: string | null;
}

/**
 * Whether an Expo/RN project exposes a Web target. If the Expo config declares
 * `platforms`, that's authoritative — web must be listed. Otherwise fall back to a
 * real web renderer being installed (`react-native-web`); `expo` alone isn't enough
 * (a managed app without react-native-web/react-dom can't serve web).
 */
export function supportsWebTarget(deps: Record<string, string>, declaredPlatforms?: readonly string[] | null): boolean {
  if (declaredPlatforms && declaredPlatforms.length > 0) return declaredPlatforms.includes("web");
  return !!deps["react-native-web"];
}

/** The Web-target decision for a project, from the strongest available signal:
 *  `expo config`'s resolved platforms (authoritative — honors app.config.ts) >
 *  app.json's platforms > react-native-web presence. Pure — the cockpit gathers the
 *  signals (spawns expo config, reads app.json + deps) and calls this. */
export function webTargetForProject(sig: {
  expoConfigPlatforms?: readonly string[] | null;
  appJsonPlatforms?: readonly string[] | null;
  deps: Record<string, string>;
}): boolean {
  const declared = sig.expoConfigPlatforms ?? sig.appJsonPlatforms ?? null;
  return supportsWebTarget(sig.deps, declared);
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
  /** Whether the project can serve web (Expo / react-native-web) — adds the Web target. */
  webCapable = false,
  /** Whether the host can drive iOS (simulator + idb are macOS-only) — adds the iOS target. */
  iosCapable = true,
): NativeInfo {
  if (kind !== "react-native")
    return { isNative: false, platforms: [], targets: [], buildStatus: "unknown", badge: null };
  const dirs = availablePlatforms(probe);
  const platforms: Platform[] = dirs.length ? dirs : ["ios"];
  // Offer iOS (macOS only — simulator/idb) + Android views; both prebuild on first
  // `expo run:<platform>`. Readiness (idb / adb + a booted device) is surfaced separately.
  const targets: ViewTarget[] = [
    ...(webCapable ? (["web"] as ViewTarget[]) : []),
    ...(iosCapable ? (["ios"] as ViewTarget[]) : []),
    "android",
  ];
  const buildStatus = fingerprintStatus(currentFingerprint, recordedFingerprint);
  return { isNative: true, platforms, targets, buildStatus, badge: buildStatusLabel(buildStatus) };
}
