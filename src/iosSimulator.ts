/**
 * iOS Simulator integration: native device logs (`simctl log stream`) and
 * screenshots (`simctl io screenshot`). Native logs cover what CDP can't see —
 * native modules, os_log/NSLog, native crashes — and land on the timeline as a
 * `native` source, correlated with the JS console the RN controller captures.
 *
 * Pure parsing + arg builders are unit-tested; NativeLogStream takes an injected
 * spawn so the parse→buffer wiring is testable without a real simulator (CI has none).
 */
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NativeLogLine {
  ts?: string;
  /** Normalized level: log | info | debug | error | fault | activity */
  level: string;
  process?: string;
  /** OS process id that emitted the line — used to route logs to the owning pane's app. */
  pid?: number;
  message: string;
}

// `log stream --style compact` two-letter type codes → our levels.
const TYPE_LEVEL: Readonly<Record<string, string>> = {
  Df: "log", // Default
  In: "info",
  Dg: "debug",
  Er: "error",
  Ft: "fault",
  Ac: "activity",
};

const NOISE = /^(Filtering the log data|Timestamp\s|Skipping debug messages|--- |Logging stream)/;

/**
 * Parse a `simctl log stream --style compact` line:
 *   "2026-06-12 21:09:00.123-0700 Df Caliburr[461:1a2b] message text"
 * Returns null for header/noise lines; keeps unrecognized lines as a plain `log`
 * message so we never silently drop real output.
 */
export function parseLogLine(raw: string): NativeLogLine | null {
  const line = raw.replace(/\r?\n$/, "").trimEnd();
  if (!line || NOISE.test(line)) return null;
  const m = /^(\d{4}-\d\d-\d\d \S+)\s+([A-Za-z]{2})\s+(\S+?)\[(\d+):[0-9a-fx]+\]\s+(.*)$/.exec(line);
  if (m) {
    return { ts: m[1], level: TYPE_LEVEL[m[2]!] ?? "log", process: m[3], pid: Number(m[4]), message: m[5]!.trim() };
  }
  return { level: "log", message: line };
}

/** Args (after `xcrun`) for streaming a booted sim's native logs, scoped to one app. */
export function logStreamArgs(opts: { device: string; match?: string; level?: string }): string[] {
  const args = ["simctl", "spawn", opts.device, "log", "stream", "--style", "compact"];
  if (opts.level) args.push("--level", opts.level);
  // Scope to the app's process so we don't drown in OS chatter.
  if (opts.match) args.push("--predicate", `processImagePath CONTAINS "${opts.match}"`);
  return args;
}

/** Args (after `xcrun`) for a booted sim screenshot to a file. */
export function screenshotArgs(device: string, outPath: string): string[] {
  return ["simctl", "io", device, "screenshot", outPath];
}

export function nativeErrorLevel(level: string): boolean {
  return level === "error" || level === "fault";
}

// --- runtime (not unit-run in CI; exercised by scripts/rn-harness.ts) ---------

interface LineProc {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  kill(): void;
}
export type SpawnLike = (cmd: string, args: string[]) => LineProc;

/**
 * Streams a booted simulator's native logs (scoped to one app) onto the buffer as
 * a `native` source. `spawn` is injectable for tests.
 */
export class NativeLogStream {
  private proc?: LineProc;
  private partial = "";

  constructor(private readonly opts: { device: string; onLine: (line: NativeLogLine) => void; spawn?: SpawnLike }) {}

  start(): void {
    const spawn = this.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args) as unknown as LineProc);
    // Broad capture — one stream per device; routing to the owning pane happens per line.
    this.proc = spawn("xcrun", logStreamArgs({ device: this.opts.device }));
    this.proc.stdout?.on("data", (chunk) => this.onData(chunk.toString()));
  }

  /** Visible for tests: feed raw stdout text through the line splitter + parser. */
  onData(chunk: string): void {
    this.partial += chunk;
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (parsed) this.opts.onLine(parsed);
    }
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}

/** Capture a booted-sim screenshot as base64 PNG (for an RN target's screenshot tool). */
export async function captureSimctlScreenshot(
  device: string,
  run: (cmd: string, args: string[]) => Promise<void> = defaultRun,
): Promise<{ base64: string; mimeType: string }> {
  const path = join(tmpdir(), `devloop-sim-${device}-${process.pid}.png`);
  await run("xcrun", screenshotArgs(device, path));
  return { base64: readFileSync(path).toString("base64"), mimeType: "image/png" };
}

function defaultRun(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}
