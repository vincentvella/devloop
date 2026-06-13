/**
 * A bounded, timestamped ring buffer for events from BOTH sides of the dev
 * loop: the dev server's terminal output and the browser (console, network,
 * page errors). Everything shares one monotonic clock, so `around(ts)` can
 * return a correlated cross-source slice of the timeline.
 */

export type LogSource = "server" | "browser" | "native";

export interface LogEntry {
  seq: number;
  ts: number;
  source: LogSource;
  /** Sub-channel: server → "stdout"|"stderr"; browser → "console"|"network"|"pageerror". */
  stream: string;
  line: string;
  /** Optional structured payload (e.g. request url + status, console location). */
  detail?: unknown;
  /** Which browser pane produced this (multi-target). Undefined for server events. */
  target?: string;
}

export class LogBuffer {
  private entries: LogEntry[] = [];
  private nextSeq = 0;
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(private readonly capacity = 5000) {}

  /** Subscribe to live pushes (used by the cockpit timeline window). Returns an unsubscribe fn. */
  onPush(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(source: LogSource, stream: string, line: string, detail?: unknown, target?: string): LogEntry {
    const entry: LogEntry = { seq: this.nextSeq++, ts: Date.now(), source, stream, line, detail, target };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* a broken listener must not break logging */
      }
    }
    return entry;
  }

  query(opts: {
    sinceSeq?: number;
    grep?: string;
    source?: LogSource;
    stream?: string;
    limit?: number;
    /** Restrict to these pane targets (server + browser logs are both tagged per pane). */
    targets?: string[];
  } = {}): LogEntry[] {
    const { sinceSeq, grep, source, stream, limit = 200, targets } = opts;
    let re: RegExp | undefined;
    if (grep) {
      try {
        re = new RegExp(grep, "i");
      } catch {
        re = undefined; // fall back to substring match
      }
    }

    let out = this.entries.filter((e) => {
      if (sinceSeq !== undefined && e.seq < sinceSeq) return false;
      if (source && e.source !== source) return false;
      if (stream && e.stream !== stream) return false;
      if (targets && (!e.target || !targets.includes(e.target))) return false;
      if (grep) {
        return re ? re.test(e.line) : e.line.toLowerCase().includes(grep.toLowerCase());
      }
      return true;
    });

    if (out.length > limit) out = out.slice(out.length - limit);
    return out;
  }

  /** Entries within +/- windowMs of timestamp `ts`, across all sources, time-ordered. */
  around(ts: number, windowMs: number, source?: LogSource, targets?: string[]): LogEntry[] {
    return this.entries.filter(
      (e) =>
        Math.abs(e.ts - ts) <= windowMs &&
        (!source || e.source === source) &&
        (!targets || (!!e.target && targets.includes(e.target))),
    );
  }

  clear(): void {
    this.entries = [];
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }
}
