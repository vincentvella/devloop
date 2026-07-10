/**
 * Manages the user's dev server as a child process and tees its stdout/stderr
 * into a LogBuffer. The command/cwd are supplied at start() time (runtime), not
 * baked into the MCP server — so a single registered server works for any
 * project. The raw output is mirrored to OUR stderr; stdout is reserved for the
 * MCP protocol.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  /** Exit code of the last run (when not running). Non-zero ⇒ it failed. */
  exitCode?: number | null;
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
  let isExpo = false;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    scripts = pkg.scripts ?? {};
    isExpo = !!(pkg.dependencies?.expo || pkg.devDependencies?.expo);
  } catch {
    throw new Error(`no package.json found in ${cwd}; pass an explicit cmd`);
  }
  // Expo apps: prefer the all-target `start` (expo start) over the web-only `web`
  // (expo start --web). One Metro then serves web AND the native dev-client, so
  // devloop's Web·iOS·Android switcher works and native panes don't collide on a
  // web-only bundler. Non-Expo projects keep web-first (Vite/Next/CRA dev servers).
  const order = isExpo ? ["dev", "develop", "start", "web", "serve"] : ["dev", "develop", "web", "start", "serve"];
  for (const name of order) {
    if (scripts[name]) return `bun run ${name}`;
  }
  if (isExpo) return "bunx expo start"; // Expo with no matching script → canonical all-target Metro
  throw new Error(
    `no dev script found in ${cwd}/package.json (looked for dev/develop/web/start/serve); pass an explicit cmd`,
  );
}

/** A project's package.json `scripts` (empty if none) — for inspecting what a dev command runs. */
export function readScripts(cwd: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/** Minimal dev-server surface the tool layer depends on (DevServer, or a per-pane facade). */
export interface DevServerLike {
  // May be async in the cockpit (a project change can recreate the pane's session, #27).
  // `label` (cockpit only) names the pane from its project when it has no label yet;
  // the headless server has no panes and ignores it.
  start(cmd: string, cwd: string, label?: string): DevStatus | Promise<DevStatus>;
  stop(): boolean;
  status(): DevStatus;
}

export class DevServer implements DevServerLike {
  private child?: ChildProcess;
  private meta?: { cmd: string; cwd: string; startedAt: number; name: string };
  private lastExit?: { code: number | null; signal: NodeJS.Signals | null };

  /** `target` tags this server's log lines with a pane id (per-pane mode). */
  constructor(
    private readonly buffer: LogBuffer,
    private readonly target?: string,
  ) {}

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
    // Poll the parent every 1s; once it's gone, SIGTERM the whole group then, after a
    // grace period, SIGKILL it. Metro/expo can ignore or slow-handle SIGTERM and keep
    // its port bound — without the SIGKILL escalation the dev server orphans and leaks
    // :8081/:3000 after the cockpit dies (the reason ports leaked on kill).
    // `trap '' TERM` is load-bearing: the watchdog signals its OWN process group, so
    // without ignoring SIGTERM it would kill itself at the first `kill -TERM -$$` and
    // never reach the SIGKILL — a SIGTERM-ignoring Metro would then survive and keep its
    // port (verified: the escalation only reaps a stubborn child WITH this trap).
    const wrapped =
      `( ${cmd} ) & CMD=$!; ` +
      `( trap '' TERM; while kill -0 ${parent} 2>/dev/null; do sleep 1; done; ` +
      `kill -TERM -$$ 2>/dev/null; sleep 3; kill -KILL -$$ 2>/dev/null ) & WATCH=$!; ` +
      // SIGKILL the watchdog on normal exit — it traps SIGTERM, so a plain `kill` wouldn't
      // stop it and it would linger polling the (now-idle) parent.
      `wait $CMD; CODE=$?; kill -KILL $WATCH 2>/dev/null; exit $CODE`; // propagate the dev cmd's exit code
    this.child = spawn(wrapped, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.meta = { cmd, cwd, startedAt: Date.now(), name: projectName(cwd) };
    this.lastExit = undefined;

    this.pipe("stdout", this.child.stdout);
    this.pipe("stderr", this.child.stderr);
    this.child.on("exit", (code, signal) => {
      this.buffer.push(
        "server",
        "stderr",
        `[devloop] dev server exited code=${code} signal=${signal}`,
        undefined,
        this.target,
      );
      this.lastExit = { code, signal };
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
        this.buffer.push("server", stream, line, undefined, this.target);
        process.stderr.write(`[dev:${stream}] ${line}\n`); // mirror to operator
      }
    });
    // Flush any trailing partial line when the stream closes. Crash output
    // (Segmentation fault / EADDRINUSE / an uncaught-exception dump) often lacks
    // a final newline, and that last line is usually the most diagnostic one —
    // without this it's silently dropped from the buffer and stderr.
    src.on("end", () => {
      if (!partial) return;
      this.buffer.push("server", stream, partial, undefined, this.target);
      process.stderr.write(`[dev:${stream}] ${partial}\n`);
      partial = "";
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
      : { running: false, exitCode: this.lastExit?.code ?? undefined };
  }

  stop(): boolean {
    if (!this.child) return false;
    const pid = this.child.pid;
    const child = this.child;
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        // Negative pid → signal the whole process group (kills grandchildren too).
        if (pid) process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        /* group already gone */
      }
    };
    signalGroup("SIGTERM");
    // Escalate to SIGKILL shortly after: Metro/expo can ignore or slow-handle SIGTERM
    // and keep its port bound. Manual stop runs while the cockpit is alive so this timer
    // fires; on a cockpit crash the in-shell watchdog does the same escalation.
    if (pid) setTimeout(() => signalGroup("SIGKILL"), 3000).unref?.();
    this.child = undefined;
    this.meta = undefined;
    return true;
  }
}
