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
  /** Every network event, threshold-independent (#26) — feeds a complete HAR + get_network. */
  private netRing: LogEntry[] = [];
  private nextSeq = 0;
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(
    private readonly capacity = 5000,
    /** Capacity of the dedicated network ring (separate from the timeline so heavy
     *  request volume can't evict console/server logs). */
    private readonly netCapacity = Number(process.env.DEVLOOP_NET_RING ?? 3000),
  ) {}

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

  /**
   * Record a network event. ALWAYS stored in the dedicated network ring (so HAR +
   * get_network see every request without tuning DEVLOOP_NET_THRESHOLD); also added to
   * the curated timeline when `timeline` is true (failures + status ≥ threshold).
   */
  network(line: string, detail: unknown, target: string | undefined, timeline: boolean): LogEntry {
    const entry: LogEntry = timeline
      ? this.push("browser", "network", line, detail, target)
      : { seq: this.nextSeq++, ts: Date.now(), source: "browser", stream: "network", line, detail, target };
    this.netRing.push(entry);
    if (this.netRing.length > this.netCapacity) this.netRing.splice(0, this.netRing.length - this.netCapacity);
    return entry;
  }

  /** The full network ring (threshold-independent), optionally scoped to panes. For HAR + get_network. */
  netEntries(opts: { targets?: string[]; limit?: number } = {}): LogEntry[] {
    const { targets, limit } = opts;
    let out = this.netRing.filter((e) => !targets || (e.target ? targets.includes(e.target) : true));
    if (limit && out.length > limit) out = out.slice(out.length - limit);
    return out;
  }

  query(
    opts: {
      sinceSeq?: number;
      grep?: string;
      source?: LogSource;
      stream?: string;
      limit?: number;
      /** Restrict to these pane targets (server + browser logs are both tagged per pane). */
      targets?: string[];
    } = {},
  ): LogEntry[] {
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
    this.netRing = [];
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }
}
