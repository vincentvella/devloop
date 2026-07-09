/**
 * Resolve a project's iOS bundle id / Android package so the cockpit can foreground
 * the matching app on the sim/mirror when you swap panes. Static — no `expo config`
 * spawn: app.json first, then the generated native project. The native fallback is the
 * reliable path here because this only runs when an app is already installed on the
 * device (the swap-to-focus precondition), which means it's been built → the native
 * dirs exist. Pure Node so it's unit-testable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readAppJsonExpo(cwd: string): { ios?: { bundleIdentifier?: string }; android?: { package?: string } } | null {
  try {
    const j = JSON.parse(readFileSync(join(cwd, "app.json"), "utf8"));
    return j?.expo ?? j ?? null; // Expo nests under `expo`; bare RN app.json is flat
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** iOS bundle id: app.json (`expo.ios.bundleIdentifier`) → the generated `ios/` project. */
export function resolveIosBundleId(cwd: string): string | null {
  return readAppJsonExpo(cwd)?.ios?.bundleIdentifier ?? iosBundleIdFromNative(cwd);
}

/** Bundle id from the native iOS project: an app Info.plist's CFBundleIdentifier,
 *  resolving the `$(PRODUCT_BUNDLE_IDENTIFIER)` build var from the .pbxproj when needed. */
export function iosBundleIdFromNative(cwd: string): string | null {
  const iosDir = join(cwd, "ios");
  for (const entry of safeReaddir(iosDir)) {
    if (/Tests?$/i.test(entry)) continue; // skip *Tests targets
    const plist = join(iosDir, entry, "Info.plist");
    if (!existsSync(plist)) continue;
    const m = readFileSync(plist, "utf8").match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    const val = m?.[1]?.trim();
    if (!val) continue;
    if (!val.includes("$(")) return val; // literal id
    break; // needs the build var → resolve from the pbxproj below
  }
  return pbxProductBundleId(iosDir);
}

function pbxProductBundleId(iosDir: string): string | null {
  const proj = safeReaddir(iosDir).find((e) => e.endsWith(".xcodeproj"));
  if (!proj) return null;
  try {
    const pbx = readFileSync(join(iosDir, proj, "project.pbxproj"), "utf8");
    // \b so we don't match the substring of DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER
    // (= YES/NO), and require a reverse-DNS dot so bare values like NO/YES never win.
    const ids = [...pbx.matchAll(/\bPRODUCT_BUNDLE_IDENTIFIER = "?([\w.-]+)"?;/g)]
      .map((m) => m[1])
      .filter((id): id is string => !!id && id.includes(".") && !id.includes("$") && !/\.(Tests|UITests)$/i.test(id));
    return ids[0] ?? null;
  } catch {
    return null;
  }
}

/** Android package: app.json (`expo.android.package`) → build.gradle → AndroidManifest. */
export function resolveAndroidPackage(cwd: string): string | null {
  return readAppJsonExpo(cwd)?.android?.package ?? androidPackageFromNative(cwd);
}

/** Package from the native Android project: build.gradle applicationId, else the manifest. */
export function androidPackageFromNative(cwd: string): string | null {
  try {
    const m = readFileSync(join(cwd, "android", "app", "build.gradle"), "utf8").match(/applicationId\s+"([\w.]+)"/);
    if (m?.[1]) return m[1];
  } catch {
    /* no build.gradle */
  }
  try {
    const manifest = readFileSync(join(cwd, "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
    const m = manifest.match(/package="([\w.]+)"/);
    if (m?.[1]) return m[1];
  } catch {
    /* no manifest */
  }
  return null;
}

/** The app id for a platform, or null when it can't be resolved. */
export function resolveAppId(cwd: string, platform: "ios" | "android"): string | null {
  return platform === "ios" ? resolveIosBundleId(cwd) : resolveAndroidPackage(cwd);
}

/** The app's custom URL scheme (Expo `expo.scheme`) — for the dev-client deep link that
 *  re-points an installed dev build at a specific Metro. First entry if it's an array;
 *  null when unset. */
export function resolveAppScheme(cwd: string): string | null {
  const scheme = (readAppJsonExpo(cwd) as { scheme?: string | string[] } | null)?.scheme;
  if (typeof scheme === "string") return scheme.trim() || null;
  if (Array.isArray(scheme) && typeof scheme[0] === "string") return scheme[0].trim() || null;
  return null;
}
