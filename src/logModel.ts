/**
 * Timeline display model — pure transforms that turn the raw entry stream into a
 * far less noisy view: it dedups consecutive identical lines (chatty native os_log
 * spam), and collapses repeated metadata (timestamp / source / pane) so a burst of
 * lines reads as one header + clean messages. Pure + unit-tested; the renderer maps
 * DisplayRow[] to DOM (see cockpit/renderer/main.tsx).
 */

/** The subset of a timeline Entry the display model needs (structural, so it's shared
 *  between the renderer's Entry and tests without a renderer import). */
export interface LogRowInput {
  seq: number;
  ts: number;
  source: string;
  stream: string;
  line: string;
  target?: string;
  detail?: { image?: string; url?: string } | undefined;
}

export interface DisplayRow<E extends LogRowInput = LogRowInput> {
  e: E;
  /** Consecutive identical lines collapsed into this row (1 = a single line). */
  count: number;
  /** Whether to render the ts/source/pane header — false for a continuation of the
   *  same source+pane within the same second (the noise-reducing collapse). */
  showMeta: boolean;
}

// Rich, individually-interactive rows (screenshots, network) are never deduped.
function dedupable(e: LogRowInput): boolean {
  return !e.detail?.image && e.stream !== "network";
}

function identical(a: LogRowInput, b: LogRowInput): boolean {
  return a.source === b.source && a.stream === b.stream && a.target === b.target && a.line === b.line;
}

function sameMeta(a: LogRowInput, b: LogRowInput): boolean {
  return a.source === b.source && a.target === b.target && Math.floor(a.ts / 1000) === Math.floor(b.ts / 1000);
}

/** Collapse a (already-filtered) entry list for display. */
export function buildDisplayRows<E extends LogRowInput>(entries: E[]): DisplayRow<E>[] {
  const out: DisplayRow<E>[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && dedupable(e) && dedupable(last.e) && identical(last.e, e)) {
      last.count++;
      continue;
    }
    out.push({ e, count: 1, showMeta: !last || !sameMeta(last.e, e) });
  }
  return out;
}

/** Split a native os_log line into its `[subsystem:category]` prefix and the rest, so the
 *  renderer can dim the subsystem chip and let the real message stand out. null if absent. */
export function parseOsLog(line: string): { subsystem: string; rest: string } | null {
  const m = line.match(/^\[([A-Za-z0-9](?:[A-Za-z0-9._-]*)(?::[A-Za-z0-9._-]+)?)\]\s?(.*)$/s);
  if (!m || !m[1]?.includes(".")) return null; // require a dotted subsystem (com.apple.…)
  return { subsystem: m[1], rest: m[2] ?? "" };
}
