/**
 * Pure helpers for wiring a native (Expo/RN) target's observability onto the
 * timeline: where its Metro inspector lives, and what process name to scope
 * native (simctl) logs to. The coordinator that owns the live controller +
 * log stream is cockpit/nativeObservability.ts.
 */

/** Origin (scheme://host:port) of a local dev-server URL — the Metro base the RN
 * controller polls for a Hermes target. null if it isn't a local http(s) URL. */
export function metroBaseFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Process name to scope native logs to. Prefer the Expo config `name`
 * (the iOS product name), else the capitalized project-dir basename. */
export function deriveAppMatch(appConfig: { name?: string; expo?: { name?: string } } | null, cwd: string): string {
  const name = appConfig?.expo?.name ?? appConfig?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const base =
    cwd
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "";
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
}
