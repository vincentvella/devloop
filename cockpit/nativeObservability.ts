/**
 * Wires a native (Expo/RN) target's observability onto the shared timeline:
 * a ReactNativeController (JS console/errors/source-maps over Metro's Hermes
 * inspector) + a NativeLogStream (simctl native/os_log), both tagged with the
 * pane id so get_logs can scope by app. One attachment per pane.
 */
import { execFile } from "node:child_process";
import type { LogBuffer } from "../src/logBuffer.ts";
import { ReactNativeController } from "../src/reactNativeController.ts";
import { NativeLogStream } from "../src/iosSimulator.ts";

/** Run `idb <args>` and resolve its stdout — the live interaction/snapshot path for
 *  react-native targets (idb taps/types/swipes + ui describe-all). idb must be on PATH. */
function runIdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("idb", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`idb failed (is idb installed? \`brew install idb-companion\`): ${stderr || (err as Error).message}`.trim()));
      else resolve(stdout);
    });
  });
}

interface Attached {
  rn: ReactNativeController;
  native?: NativeLogStream;
}

export class NativeObservability {
  private readonly byPane = new Map<string, Attached>();

  constructor(
    private readonly buffer: LogBuffer,
    private readonly log: (m: string) => void,
  ) {}

  isAttached(paneId: string): boolean {
    return this.byPane.has(paneId);
  }

  /** Start streaming JS + native logs for a pane. No-op if already attached. */
  attach(opts: { paneId: string; metroBase: string; device: string; appMatch?: string }): void {
    if (this.byPane.has(opts.paneId)) return;
    this.log(`native observability: pane ${opts.paneId} → JS=${opts.metroBase}${opts.appMatch ? ` native~"${opts.appMatch}"` : ""}`);
    const rn = new ReactNativeController(this.buffer, { metroBase: opts.metroBase, target: opts.paneId, device: opts.device, idb: runIdb });
    void rn.start();
    let native: NativeLogStream | undefined;
    if (opts.appMatch) {
      native = new NativeLogStream(this.buffer, { device: opts.device, match: opts.appMatch, target: opts.paneId });
      native.start();
    }
    this.byPane.set(opts.paneId, { rn, native });
  }

  detach(paneId: string): void {
    const a = this.byPane.get(paneId);
    if (!a) return;
    this.byPane.delete(paneId);
    void a.rn.close();
    a.native?.stop();
    this.log(`native observability: detached pane ${paneId}`);
  }

  detachAll(): void {
    for (const id of [...this.byPane.keys()]) this.detach(id);
  }
}
