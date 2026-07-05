/**
 * Auto-assign a free Metro/Expo port so multiple native panes (or devloop instances)
 * don't collide on 8081 — which makes `expo start` try to interactively prompt "use
 * another port?" and then die, because devloop runs it non-interactively.
 *
 * Pure command helpers (unit-tested) + a live free-port scan (OS-level, so it also skips
 * ports held by other devloop instances / apps).
 */
import { createServer } from "node:net";

export const METRO_BASE_PORT = 8081;

/** Resolve `bun run <script>` (npm/pnpm/yarn too) to the script body, so we can inspect
 *  what actually runs; a direct command is returned unchanged. */
export function resolveScript(cmd: string, scripts: Record<string, string>): string {
  const m = cmd.match(/^(?:bun run|npm run|pnpm run|pnpm|yarn run|yarn)\s+(\S+)/);
  return m && scripts[m[1] as string] ? (scripts[m[1] as string] as string) : cmd;
}

/** Whether the dev command launches a Metro/Expo server (defaults to :8081). */
export function usesMetro(cmd: string, scripts: Record<string, string> = {}): boolean {
  const text = `${cmd} ${resolveScript(cmd, scripts)}`;
  return /\bexpo\s+start\b|\breact-native\s+start\b|\bmetro\b/.test(text);
}

/** Whether the command (or its script) already pins a port — respect it, don't override. */
export function hasExplicitPort(cmd: string, scripts: Record<string, string> = {}): boolean {
  const text = `${cmd} ${resolveScript(cmd, scripts)}`;
  return /--port(=|\s+)\d|(^|\s)-p\s+\d|RCT_METRO_PORT=/.test(text);
}

/** Append `--port <port>`, forwarding through a package-runner (`bun run …`) when needed. */
export function withMetroPort(cmd: string, port: number): string {
  const viaRunner = /^(?:bun run|npm run|pnpm run|pnpm|yarn run|yarn)\s+\S+/.test(cmd);
  return viaRunner ? `${cmd} -- --port ${port}` : `${cmd} --port ${port}`;
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** First free TCP port at/above `base`, skipping `reserved` (ports we've already handed
 *  out this session but that may not be bound yet). Falls back to `base` after `tries`. */
export async function freePort(base: number, reserved: ReadonlySet<number> = new Set(), tries = 100): Promise<number> {
  for (let p = base; p < base + tries; p++) {
    if (reserved.has(p)) continue;
    if (await isFree(p)) return p;
  }
  return base;
}

/** Rewrite a dev command to pin a free Metro port when it needs one; otherwise unchanged.
 *  Returns the (possibly) rewritten command + the port assigned (undefined if untouched). */
export async function assignMetroPort(
  cmd: string,
  scripts: Record<string, string>,
  reserved: ReadonlySet<number> = new Set(),
): Promise<{ cmd: string; port?: number }> {
  if (!usesMetro(cmd, scripts) || hasExplicitPort(cmd, scripts)) return { cmd };
  const port = await freePort(METRO_BASE_PORT, reserved);
  return { cmd: withMetroPort(cmd, port), port };
}
