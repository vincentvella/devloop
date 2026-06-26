/**
 * Manages the serve-sim process — the engine that captures the booted iOS
 * Simulator and serves its MJPEG stream. We consume its raw stream URL (from
 * /api) in an <img> inside a pane view, rather than loading serve-sim's full UI.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SERVE_SIM_API,
  SERVE_SIM_URL,
  type SimInfo,
  serveSimSpawn,
  serveSimVendoredSpawn,
  simInfoFromApi,
} from "../src/simulator.ts";

export class ServeSim {
  private proc?: ChildProcess;

  constructor(private readonly log: (m: string) => void) {}

  /** Ensure serve-sim is up, then return the booted device's {device, url} (or null). */
  async ensure(): Promise<SimInfo | null> {
    if (!(await this.up())) {
      if (!this.proc || this.proc.killed) {
        const launch = this.buildLaunch();
        if (!launch) return null;
        this.proc = spawn(launch.cmd, launch.args, { stdio: "ignore", env: launch.env });
        this.proc.on("error", (e) => this.log(`serve-sim: spawn failed (${e.message})`));
        this.proc.on("exit", (code) => this.log(`serve-sim: exited (${code})`));
      }
      for (let i = 0; i < 40 && !(await this.up()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    return this.info();
  }

  /**
   * Decide how to start serve-sim. Prefer the vendored copy (shipped in the app,
   * run via Electron's own Node — offline, no external runtime). Otherwise fall
   * back to bunx/npx from the user's PATH. null + logs if nothing is available.
   */
  private buildLaunch(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
    const entry = this.vendoredEntry();
    if (entry) {
      const s = serveSimVendoredSpawn(process.execPath, entry);
      this.log(`serve-sim: starting vendored copy via Electron Node (${entry})`);
      return { cmd: s.cmd, args: s.args, env: { ...process.env, ...s.env } };
    }
    const runner = this.pickRunner();
    if (!runner) {
      this.log(
        "serve-sim: no vendored copy and no bun/node on PATH — can't start the simulator (reinstall, or install bun/node)",
      );
      return null;
    }
    const { cmd, args } = serveSimSpawn(runner);
    this.log(`serve-sim: no vendored copy; starting via ${cmd} (${cmd} ${args.join(" ")})`);
    return { cmd, args, env: process.env };
  }

  /**
   * Path to the vendored serve-sim entry, or null. Packaged: under Resources/
   * node_modules (its `ws`/`inspect-webkit` deps sit alongside so ESM resolution
   * finds them). Dev: the repo's node_modules (deps hoisted to the root).
   */
  private vendoredEntry(): string | null {
    const candidates = [
      process.resourcesPath ? join(process.resourcesPath, "node_modules", "serve-sim", "dist", "serve-sim.js") : "",
      join(process.cwd(), "node_modules", "serve-sim", "dist", "serve-sim.js"),
    ];
    return candidates.find((p) => p && existsSync(p)) ?? null;
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
      const api = (await (await fetch(SERVE_SIM_API, { signal: AbortSignal.timeout(3000) })).json()) as {
        device?: string;
        url?: string;
      };
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
