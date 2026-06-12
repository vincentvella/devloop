/**
 * Pure update-version logic, shared by the cockpit's auto-updater.
 * electron-updater decides when to fire `update-available`, but for the *manual*
 * "Check for updates" flow we compare the resolved remote version against the
 * running one ourselves to show an accurate "you're up to date" message — and
 * that comparison is worth unit-testing in isolation from Electron.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** dot-separated prerelease identifiers, e.g. ["beta", "1"]; empty for a stable release */
  pre: string[];
}

/** Parse "1.2.3", "v1.2.3", "1.2.3-beta.1" (build metadata after "+" is ignored). null if unparseable. */
export function parseSemver(input: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** -1 / 0 / 1 per semver precedence (a release outranks a prerelease of the same x.y.z). */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // No prerelease ranks higher than any prerelease.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1; // shorter prerelease is lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True iff `candidate` is a strictly newer version than `current`. Unparseable inputs → false. */
export function isNewerVersion(current: string, candidate: string): boolean {
  const c = parseSemver(current);
  const n = parseSemver(candidate);
  if (!c || !n) return false;
  return compareSemver(n, c) > 0;
}

export function updateAvailableMessage(current: string, available: string): string {
  return `Devloop ${available} is available (you're on ${current}). Download it now?`;
}

export function updateReadyMessage(version: string): string {
  return `Devloop ${version} has been downloaded. Restart to install it.`;
}

export function upToDateMessage(current: string): string {
  return `You're up to date — Devloop ${current} is the latest version.`;
}
