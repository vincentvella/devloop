/**
 * "What's broken right now" — group/dedupe error entries and collect network
 * failures from the buffer, with an agent-readable summary. Pure over LogEntry[].
 */

import type { NetDetail } from "./har.ts";
import type { LogEntry } from "./logBuffer.ts";

export interface ErrorGroup {
  source: string;
  stream: string;
  sample: string; // first raw line of the group
  count: number;
  firstTs: number;
  lastTs: number;
  targets: string[];
}

export interface NetFailure {
  method?: string;
  url: string;
  status?: number;
  failure?: string;
  count: number;
}

export interface DiagnoseResult {
  windowMs: number | null;
  errorCount: number;
  groups: ErrorGroup[];
  network: NetFailure[];
  /** Actionable native (RN/iOS) findings — e.g. a stale native build, idb not ready. */
  nativeNotes: string[];
  summary: string;
}

// A missing native module at runtime almost always means the native build is stale
// (JS references a module the compiled app doesn't include) — a rebuild fixes it.
const STALE_NATIVE_RE =
  /cannot find native module|tried to access a native module that does(?:n'|n')t exist|requirenativecomponent|turbomodule\b.*(?:not found|null)|native module .*(?:cannot be null|is null|doesn'?t exist)/i;

/** A one-line "native build is stale — rebuild" note if the error groups show the signature. */
export function staleNativeBuildNote(groups: ErrorGroup[]): string | null {
  const hit = groups.find((g) => STALE_NATIVE_RE.test(g.sample));
  if (!hit) return null;
  const mod = /native module '([^']+)'/i.exec(hit.sample)?.[1];
  return `native build looks stale — a native module${mod ? ` ('${mod}')` : ""} the JS uses isn't in the running build. Rebuild (▶ Build / \`expo run:ios\`) so the binary matches the JS.`;
}

const isServerError = (e: LogEntry) =>
  e.source === "server" && /error|exception|traceback|unhandled|fatal|\bpanic\b/i.test(e.line);
const isConsoleError = (e: LogEntry) => e.source === "browser" && e.stream === "console" && /\[error\]/i.test(e.line);
const isPageError = (e: LogEntry) => e.stream === "pageerror";
// Native crash / fatal signatures from the device log stream (iOS simctl + Android
// logcat), pushed as source:"native". Without this, diagnose() is blind to native-side
// crashes. Also treat a native stale-module line as an error so its group feeds
// staleNativeBuildNote — a stale crash that surfaces only via a native line (not a JS
// pageerror) would otherwise never trigger the rebuild hint. (VEL-65)
const NATIVE_ERROR_RE = /fatal exception|exception|sigabrt|crash|anr\b|nse?exception|exc_bad_access|fatal error/i;
const isNativeError = (e: LogEntry) =>
  e.source === "native" && (NATIVE_ERROR_RE.test(e.line) || STALE_NATIVE_RE.test(e.line));
const isNetFailure = (e: LogEntry) => {
  if (e.stream !== "network") return false;
  const d = e.detail as NetDetail | undefined;
  return !!d && (!!d.failure || d.status === undefined || (d.status ?? 0) >= 400);
};

const signature = (e: LogEntry) =>
  `${e.source}:${e.stream}:${e.line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200)}`;

export function diagnose(entries: LogEntry[], opts: { windowMs?: number | null; now?: number } = {}): DiagnoseResult {
  const windowMs = opts.windowMs ?? null;
  const now = opts.now ?? Date.now();
  const considered = windowMs == null ? entries : entries.filter((e) => now - e.ts <= windowMs);

  const groups = new Map<string, ErrorGroup>();
  const network = new Map<string, NetFailure>();
  let errorCount = 0;

  for (const e of considered) {
    if (isNetFailure(e)) {
      errorCount++;
      const d = e.detail as NetDetail;
      const key = `${d.method ?? ""} ${d.url} ${d.status ?? d.failure ?? ""}`;
      const g = network.get(key) ?? { method: d.method, url: d.url, status: d.status, failure: d.failure, count: 0 };
      g.count++;
      network.set(key, g);
    } else if (isPageError(e) || isConsoleError(e) || isServerError(e) || isNativeError(e)) {
      errorCount++;
      const sig = signature(e);
      const g = groups.get(sig) ?? {
        source: e.source,
        stream: e.stream,
        sample: e.line,
        count: 0,
        firstTs: e.ts,
        lastTs: e.ts,
        targets: [],
      };
      g.count++;
      g.firstTs = Math.min(g.firstTs, e.ts);
      g.lastTs = Math.max(g.lastTs, e.ts);
      if (e.target && !g.targets.includes(e.target)) g.targets.push(e.target);
      groups.set(sig, g);
    }
  }

  const groupList = [...groups.values()].sort((a, b) => b.count - a.count);
  const netList = [...network.values()].sort((a, b) => b.count - a.count);
  const nativeNotes: string[] = [];
  const stale = staleNativeBuildNote(groupList);
  if (stale) nativeNotes.push(stale);

  const errPart =
    errorCount === 0
      ? "no errors detected"
      : `${errorCount} error${errorCount > 1 ? "s" : ""}${windowMs ? ` in the last ${Math.round(windowMs / 1000)}s` : ""}: ` +
        [
          ...groupList.slice(0, 3).map((g) => `${g.count}× ${g.sample.slice(0, 80)}`),
          ...netList.slice(0, 3).map((n) => `${n.count}× ${n.status ?? n.failure} ${n.method ?? ""} ${n.url}`),
        ].join("; ");
  // Lead with native findings — they're usually the root cause when present.
  const summary = nativeNotes.length ? `${nativeNotes.join(" ")} | ${errPart}` : errPart;

  return { windowMs, errorCount, groups: groupList, network: netList, nativeNotes, summary };
}
