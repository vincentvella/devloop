/**
 * Manages the serve-sim process — the engine that captures the booted iOS
 * Simulator and serves its MJPEG stream. We consume its raw stream URL (from
 * /api) in an <img> inside a pane view, rather than loading serve-sim's full UI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { serveSimSpawn, SERVE_SIM_URL, SERVE_SIM_API, streamUrlFromApi } from "../src/simulator.ts";

export class ServeSim {
  private proc?: ChildProcess;

  constructor(private readonly log: (m: string) => void) {}

  /** Ensure serve-sim is up, then return the booted device's MJPEG stream URL (or null). */
  async ensure(): Promise<string | null> {
    if (!(await this.up())) {
      if (!this.proc || this.proc.killed) {
        const { cmd, args } = serveSimSpawn();
        this.log(`serve-sim: starting (${cmd} ${args.join(" ")})`);
        this.proc = spawn(cmd, args, { stdio: "ignore" });
        this.proc.on("exit", (code) => this.log(`serve-sim: exited (${code})`));
      }
      for (let i = 0; i < 40 && !(await this.up()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    return this.streamUrl();
  }

  private async up(): Promise<boolean> {
    try {
      return (await fetch(SERVE_SIM_URL, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  }

  private async streamUrl(): Promise<string | null> {
    try {
      const api = (await (await fetch(SERVE_SIM_API, { signal: AbortSignal.timeout(3000) })).json()) as { streamUrl?: string };
      return streamUrlFromApi(api);
    } catch {
      return null;
    }
  }

  stop(): void {
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.proc = undefined;
  }
}
