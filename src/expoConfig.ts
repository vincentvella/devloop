/**
 * Resolve an Expo project's `platforms` via `expo config` — authoritative (it
 * evaluates app.config.ts + app.json + Expo defaults), unlike a static app.json read.
 * Node-only (no electron) so it's importable from tests + the cockpit. Uncached here —
 * the cockpit persists the result keyed by projectInputsHash (see registry.ts).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Content hash of the files that determine a project's targets — package.json + the
 *  Expo config. The detection cache key: stable across touches / `git checkout` (unlike
 *  mtime), busts only when the content actually changes. Cheap (reads a few small files). */
export function projectInputsHash(cwd: string): string {
  const h = createHash("sha1");
  for (const f of ["package.json", "app.json", "app.config.ts", "app.config.js", "app.config.mjs"]) {
    try {
      h.update(f)
        .update("\0")
        .update(readFileSync(join(cwd, f)))
        .update("\0");
    } catch {
      /* missing — contributes nothing */
    }
  }
  return h.digest("hex");
}

/** Platforms from `expo config --json` (honors app.config.ts). null when expo config
 *  isn't available (no expo, eval error, timeout) — the caller falls back statically. */
export async function resolvedExpoPlatforms(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("bunx", ["expo", "config", "--json", "--type", "public"], {
      cwd,
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const cfg = JSON.parse(stdout);
    if (Array.isArray(cfg?.platforms)) return cfg.platforms;
  } catch {
    /* no expo / eval error / timeout → caller falls back to the static heuristic */
  }
  return null;
}

/** `platforms` declared statically in app.json (`expo.platforms` or top-level). null if
 *  absent or the project uses app.config.(ts|js), which can't be parsed statically. */
export function readAppJsonPlatforms(cwd: string): string[] | null {
  try {
    const appJson = JSON.parse(readFileSync(join(cwd, "app.json"), "utf8"));
    const p = appJson?.expo?.platforms ?? appJson?.platforms;
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}
