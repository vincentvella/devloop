/**
 * Resolve minified browser stack traces back to original source via source maps.
 * The browser only de-minifies stacks in its DevTools UI — `error.stack` (what an
 * agent reads through devloop) stays compiled — so we map it ourselves.
 */
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { LogEntry } from "./logBuffer.ts";

export interface Frame {
  fn?: string;
  url: string;
  line: number;
  column: number;
}

export interface ResolvedFrame {
  fn?: string;
  source: string;
  line: number | null;
  column: number | null;
  name?: string | null;
  raw?: boolean; // true if it couldn't be mapped (left as the compiled location)
}

/** Parse a V8 stack-trace string into frames. Pure. */
export function parseStackFrames(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    let m = line.match(/^at (.+?) \((.+):(\d+):(\d+)\)$/); // at fn (url:line:col)
    if (m) {
      frames.push({ fn: m[1], url: m[2]!, line: +m[3]!, column: +m[4]! });
      continue;
    }
    m = line.match(/^at (.+):(\d+):(\d+)$/); // at url:line:col
    if (m) frames.push({ url: m[1]!, line: +m[2]!, column: +m[3]! });
  }
  return frames;
}

export interface Resolver {
  resolve(
    url: string,
    line: number,
    column: number,
  ): Promise<{ source: string; line: number | null; column: number | null; name: string | null } | null>;
}

async function loadMap(jsUrl: string, fetchImpl: typeof fetch): Promise<TraceMap | null> {
  const res = await fetchImpl(jsUrl);
  if (!res.ok) return null;
  const code = await res.text();
  const all = [...code.matchAll(/sourceMappingURL=([^\s'"]+)/g)];
  if (!all.length) return null;
  const smUrl = all[all.length - 1]![1]!;
  let rawMap: string;
  if (smUrl.startsWith("data:")) {
    const b64 = smUrl.split("base64,")[1];
    rawMap = b64
      ? Buffer.from(b64, "base64").toString("utf8")
      : decodeURIComponent(smUrl.slice(smUrl.indexOf(",") + 1));
  } else {
    const mres = await fetchImpl(new URL(smUrl, jsUrl).href);
    if (!mres.ok) return null;
    rawMap = await mres.text();
  }
  return new TraceMap(JSON.parse(rawMap));
}

/** A resolver that fetches each bundle's source map once (cached) and maps positions. */
export function createResolver(fetchImpl: typeof fetch = fetch): Resolver {
  const cache = new Map<string, Promise<TraceMap | null>>();
  const mapFor = (url: string) => {
    if (!cache.has(url))
      cache.set(
        url,
        loadMap(url, fetchImpl).catch(() => null),
      );
    return cache.get(url)!;
  };
  return {
    async resolve(url, line, column) {
      if (!/^https?:|^file:/.test(url)) return null;
      const tm = await mapFor(url);
      if (!tm) return null;
      const pos = originalPositionFor(tm, { line, column });
      if (pos.source == null) return null;
      return { source: pos.source, line: pos.line ?? null, column: pos.column ?? null, name: pos.name ?? null };
    },
  };
}

/** Resolve a whole stack string. Returns null if nothing mapped. */
export async function resolveStackString(
  stack: string,
  resolver: Resolver,
): Promise<{ frames: ResolvedFrame[]; pretty: string } | null> {
  const frames = parseStackFrames(stack);
  if (!frames.length) return null;
  const resolved: ResolvedFrame[] = await Promise.all(
    frames.map(async (f) => {
      const r = await resolver.resolve(f.url, f.line, f.column).catch(() => null);
      return r
        ? { fn: f.fn, source: r.source, line: r.line, column: r.column, name: r.name }
        : { fn: f.fn, source: f.url, line: f.line, column: f.column, raw: true };
    }),
  );
  if (!resolved.some((r) => !r.raw)) return null; // nothing mapped — not worth attaching
  const pretty = resolved
    .map((r) => `    at ${r.fn ?? r.name ?? "<anonymous>"} (${r.source}:${r.line}:${r.column})`)
    .join("\n");
  return { frames: resolved, pretty };
}

/** Shared resolver using the global fetch (dev servers on localhost are reachable from Node). */
export const defaultResolver = createResolver();

/** Best-effort: resolve `stack` and patch the entry's detail with the original-source frames. */
export async function attachResolvedStack(entry: LogEntry, stack: string): Promise<void> {
  const r = await resolveStackString(stack, defaultResolver).catch(() => null);
  if (r)
    entry.detail = { ...((entry.detail as object | undefined) ?? {}), resolvedStack: r.frames, prettyStack: r.pretty };
}
