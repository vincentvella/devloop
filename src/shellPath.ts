/**
 * Pure helpers for importing the user's login-shell PATH into a packaged app.
 *
 * A macOS/Linux app launched from Finder/Dock inherits a minimal PATH
 * (/usr/bin:/bin:…), NOT the shell PATH where bun/node/expo/Homebrew live — so
 * spawned dev tooling (serve-sim, expo start, bun run dev) can't be found. We run
 * the login shell once to get its PATH and merge it in. The shell-running is in
 * cockpit/main.ts; the merge + parse are here, unit-tested.
 */

const SEP = ":";

/** Merge a shell-derived PATH into the current one — shell entries first, deduped. */
export function mergePath(current: string | undefined, fromShell: string | undefined): string {
  const parts = [...(fromShell ?? "").split(SEP), ...(current ?? "").split(SEP)].map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].join(SEP);
}

/** Extract the PATH from marker-delimited shell output (`printf '<marker>%s' "$PATH"`). */
export function parseShellPath(output: string, marker: string): string | null {
  const i = output.lastIndexOf(marker);
  if (i < 0) return null;
  const path = output.slice(i + marker.length).trim();
  return path || null;
}
