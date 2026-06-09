/**
 * Manages the user's dev server as a child process and tees its stdout/stderr
 * into a LogBuffer. The command/cwd are supplied at start() time (runtime), not
 * baked into the MCP server — so a single registered server works for any
 * project. The raw output is mirrored to OUR stderr; stdout is reserved for the
 * MCP protocol.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { LogBuffer } from "./logBuffer.ts";

type ServerStream = "stdout" | "stderr";

export interface DevStatus {
  running: boolean;
  cmd?: string;
  cwd?: string;
  pid?: number;
  startedAt?: number;
  /** Project name — package.json "name", else the folder basename. */
  name?: string;
}

/** Derive a project's display name: package.json "name", falling back to the folder name. */
export function projectName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    /* no package.json */
  }
  return basename(cwd) || cwd;
}

/** Pick a dev command from a project's package.json scripts. Throws if none found. */
export function detectDevCommand(cwd: string): string {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    scripts = pkg.scripts ?? {};
  } catch {
    throw new Error(`no package.json found in ${cwd}; pass an explicit cmd`);
  }
  for (const name of ["dev", "develop", "web", "start", "serve"]) {
    if (scripts[name]) return `bun run ${name}`;
  }
  throw new Error(
    `no dev script found in ${cwd}/package.json (looked for dev/develop/web/start/serve); pass an explicit cmd`,
  );
}

export class DevServer {
  private child?: ChildProcess;
  private meta?: { cmd: string; cwd: string; startedAt: number; name: string };

  constructor(private readonly buffer: LogBuffer) {}

  start(cmd: string, cwd: string): DevStatus {
    if (this.child) {
      throw new Error(`dev server already running (${this.meta?.cmd}); stop it first`);
    }
    // Shell so callers can pass a full command line, e.g. "bun run dev" or
    // "bun run web -- --port 8090". `detached` makes the child a process-group
    // leader so stop() can kill the whole tree (the shell AND its grandchildren
    // like `next dev`/`metro`) via process.kill(-pid).
    //
    // We also wrap it with a parent-pid watchdog: a background loop kills the
    // whole group if THIS process (the cockpit/stdio server) dies — so a crash
    // or SIGKILL of the parent can't orphan the dev server (e.g. leaving :3000
    // held). On normal exit of the command, the watchdog is torn down.
    const parent = process.pid;
    const wrapped =
      `( ${cmd} ) & CMD=$!; ` +
      `( while kill -0 ${parent} 2>/dev/null; do sleep 2; done; kill -TERM -$$ 2>/dev/null ) & WATCH=$!; ` +
      `wait $CMD; kill $WATCH 2>/dev/null`;
    this.child = spawn(wrapped, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.meta = { cmd, cwd, startedAt: Date.now(), name: projectName(cwd) };

    this.pipe("stdout", this.child.stdout);
    this.pipe("stderr", this.child.stderr);
    this.child.on("exit", (code, signal) => {
      this.buffer.push("server", "stderr", `[devloop] dev server exited code=${code} signal=${signal}`);
      this.child = undefined;
      this.meta = undefined;
    });

    process.stderr.write(`[devloop] started dev server: ${cmd} (cwd: ${cwd})\n`);
    return this.status();
  }

  private pipe(stream: ServerStream, src: NodeJS.ReadableStream | null): void {
    if (!src) return;
    let partial = "";
    src.setEncoding("utf8");
    src.on("data", (chunk: string) => {
      partial += chunk;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? ""; // keep incomplete trailing line
      for (const line of lines) {
        this.buffer.push("server", stream, line);
        process.stderr.write(`[dev:${stream}] ${line}\n`); // mirror to operator
      }
    });
  }

  status(): DevStatus {
    return this.child
      ? {
          running: true,
          cmd: this.meta?.cmd,
          cwd: this.meta?.cwd,
          pid: this.child.pid,
          startedAt: this.meta?.startedAt,
          name: this.meta?.name,
        }
      : { running: false };
  }

  stop(): boolean {
    if (!this.child) return false;
    const pid = this.child.pid;
    try {
      // Negative pid → signal the whole process group (kills grandchildren too).
      if (pid) process.kill(-pid, "SIGTERM");
      else this.child.kill("SIGTERM");
    } catch {
      this.child.kill("SIGTERM"); // group already gone / not a leader
    }
    this.child = undefined;
    this.meta = undefined;
    return true;
  }
}
