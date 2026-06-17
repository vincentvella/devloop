/**
 * Manages the serve-sim process — the engine that captures the booted iOS
 * Simulator and serves its MJPEG stream. We consume its raw stream URL (from
 * /api) in an <img> inside a pane view, rather than loading serve-sim's full UI.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { serveSimSpawn, SERVE_SIM_URL, SERVE_SIM_API, simInfoFromApi, type SimInfo } from "../src/simulator.ts";

export class ServeSim {
  private proc?: ChildProcess;

  constructor(private readonly log: (m: string) => void) {}

  /** Ensure serve-sim is up, then return the booted device's {device, url} (or null). */
  async ensure(): Promise<SimInfo | null> {
    if (!(await this.up())) {
      if (!this.proc || this.proc.killed) {
        const runner = this.pickRunner();
        if (!runner) {
          this.log("serve-sim: no bun or node found on PATH — can't start the simulator (install bun or node)");
          return null;
        }
        const { cmd, args } = serveSimSpawn(runner);
        this.log(`serve-sim: starting (${cmd} ${args.join(" ")})`);
        this.proc = spawn(cmd, args, { stdio: "ignore" });
        this.proc.on("error", (e) => this.log(`serve-sim: spawn failed (${e.message})`));
        this.proc.on("exit", (code) => this.log(`serve-sim: exited (${code})`));
      }
      for (let i = 0; i < 40 && !(await this.up()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    return this.info();
  }

  /** Prefer bun (bunx); fall back to npx for node-only machines. null if neither. */
  private pickRunner(): "bunx" | "npx" | null {
    if (this.has("bunx") || this.has("bun")) return "bunx";
    if (this.has("npx")) return "npx";
    return null;
  }
  private has(cmd: string): boolean {
    try {
      execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private async up(): Promise<boolean> {
    try {
      return (await fetch(SERVE_SIM_URL, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  }

  private async info(): Promise<SimInfo | null> {
    try {
      const api = (await (await fetch(SERVE_SIM_API, { signal: AbortSignal.timeout(3000) })).json()) as { device?: string; url?: string };
      return simInfoFromApi(api);
    } catch {
      return null;
    }
  }

  stop(): void {
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.proc = undefined;
  }
}
