/**
 * Resolve an Expo project's `platforms` via `expo config` — authoritative (it
 * evaluates app.config.ts + app.json + Expo defaults), unlike a static app.json read.
 * Node-only (no electron) so it's importable from tests + the cockpit. Cached per cwd,
 * keyed on the config files' mtime so edits invalidate the cache.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const platformsCache = new Map<string, { key: number; platforms: string[] | null }>();

function configMtime(cwd: string): number {
  let m = 0;
  for (const f of ["app.config.ts", "app.config.js", "app.config.mjs", "app.json", "package.json"]) {
    try {
      m = Math.max(m, statSync(join(cwd, f)).mtimeMs);
    } catch {
      /* missing — ignore */
    }
  }
  return m;
}

/** Platforms from `expo config --json` (honors app.config.ts). null when expo config
 *  isn't available (no expo, eval error, timeout) — the caller falls back statically. */
export async function resolvedExpoPlatforms(cwd: string): Promise<string[] | null> {
  const key = configMtime(cwd);
  const hit = platformsCache.get(cwd);
  if (hit && hit.key === key) return hit.platforms;
  let platforms: string[] | null = null;
  try {
    const { stdout } = await execFileP("bunx", ["expo", "config", "--json", "--type", "public"], {
      cwd,
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const cfg = JSON.parse(stdout);
    if (Array.isArray(cfg?.platforms)) platforms = cfg.platforms;
  } catch {
    /* no expo / eval error / timeout → caller falls back to the static heuristic */
  }
  platformsCache.set(cwd, { key, platforms });
  return platforms;
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
