/**
 * Native-readiness preflight for the iOS target. Driving a simulator via idb needs
 * three things present, and each has a non-obvious fix (learned the hard way):
 *   - idb_companion (the binary that talks to the sim) — a Facebook brew tap
 *   - the `idb` CLI (fb-idb) — pip/pipx, and it breaks on Python ≥ 3.14
 *   - a booted simulator
 * Rather than let a tap fail with a cryptic spawn error, we probe + surface an
 * actionable message. Pure (takes a probe result); the cockpit runs the probe.
 */

export interface NativeEnvProbe {
  /** `idb` CLI resolvable on PATH. */
  idb: boolean;
  /** `idb_companion` resolvable on PATH. */
  idbCompanion: boolean;
  /** At least one booted simulator. */
  bootedSim: boolean;
}

export interface NativeEnvIssue {
  what: string;
  fix: string;
}

/** Actionable gaps preventing native interactions, in install order. Empty ⇒ ready. */
export function nativeEnvIssues(p: NativeEnvProbe): NativeEnvIssue[] {
  const issues: NativeEnvIssue[] = [];
  if (!p.idbCompanion) issues.push({ what: "idb_companion not found", fix: "brew install facebook/fb/idb-companion" });
  if (!p.idb) issues.push({ what: "idb CLI not found", fix: "pipx install fb-idb  (needs Python <3.14, e.g. `pipx install --python python3.12 fb-idb`)" });
  if (!p.bootedSim) issues.push({ what: "no booted simulator", fix: "boot one in Simulator.app, or run a build (▶ Build / `expo run:ios`)" });
  return issues;
}

export const nativeEnvReady = (p: NativeEnvProbe): boolean => nativeEnvIssues(p).length === 0;

export interface NativeEnvCheck {
  label: string;
  ok: boolean;
  /** How to fix it (present only when !ok). */
  fix?: string;
}

/** Per-requirement checklist for the cockpit's preflight panel (✓/✗ + fix). */
export function nativeEnvChecks(p: NativeEnvProbe): NativeEnvCheck[] {
  return [
    { label: "idb_companion", ok: p.idbCompanion, fix: p.idbCompanion ? undefined : "brew install facebook/fb/idb-companion" },
    { label: "idb CLI (fb-idb)", ok: p.idb, fix: p.idb ? undefined : "pipx install fb-idb  (needs Python <3.14)" },
    { label: "Booted simulator", ok: p.bootedSim, fix: p.bootedSim ? undefined : "Boot one in Simulator.app, or run a build (▶ Build)" },
  ];
}

/** One-line, agent/human-readable summary of native readiness. */
export function nativeEnvSummary(p: NativeEnvProbe): string {
  const issues = nativeEnvIssues(p);
  if (!issues.length) return "native interactions ready (idb + companion + booted simulator)";
  return `native interactions unavailable — ${issues.map((i) => `${i.what} → ${i.fix}`).join("; ")}`;
}
