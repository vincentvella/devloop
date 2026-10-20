/**
 * Daemon discovery state — a tiny JSON file the daemon writes on boot so stdio
 * clients (and `daemon --status` / `--stop`) can find a running instance without
 * guessing ports. Lives at $DEVLOOP_HOME/daemon.json (default ~/.devloop), or — for a
 * per-project daemon (DEVLOOP_DAEMON_SCOPE set) — $DEVLOOP_HOME/daemons/<hash>.json, so
 * each project finds its own. Pure Node; mirrors registry.ts's lazy DEVLOOP_HOME resolution.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonState {
  pid: number;
  port: number;
  url: string; // the MCP endpoint, e.g. http://localhost:7333/mcp
  startedAt: string; // ISO timestamp
  scope?: string; // the project directory a per-project daemon serves; absent = global
}

const dir = (): string => process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop");
/** The project directory this process's daemon is scoped to, or undefined for the global one. */
export const daemonScope = (): string | undefined => process.env.DEVLOOP_DAEMON_SCOPE || undefined;

export const daemonStateFile = (scope = daemonScope()): string =>
  scope
    ? join(dir(), "daemons", `${createHash("sha256").update(scope).digest("hex").slice(0, 16)}.json`)
    : join(dir(), "daemon.json");

export function writeDaemonState(s: DaemonState): void {
  mkdirSync(dirname(daemonStateFile()), { recursive: true });
  writeFileSync(daemonStateFile(), JSON.stringify(s, null, 2));
}

export function readDaemonState(): DaemonState | undefined {
  try {
    const s = JSON.parse(readFileSync(daemonStateFile(), "utf8"));
    if (typeof s?.pid === "number" && typeof s?.port === "number" && typeof s?.url === "string") return s;
  } catch {
    /* no file / unreadable */
  }
  return undefined;
}

export function clearDaemonState(): void {
  try {
    unlinkSync(daemonStateFile());
  } catch {
    /* already gone */
  }
}

/**
 * Take the exclusive "I'm starting this scope's daemon" lock — a file created with
 * O_EXCL beside the state file — so concurrent launches for one project spawn ONE
 * daemon. Returns a release fn, or undefined while another live process holds it.
 * A lock whose holder is dead, or older than `staleMs`, is broken and retaken.
 */
export function acquireSpawnLock(staleMs: number): (() => void) | undefined {
  const file = `${daemonStateFile()}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx" });
      return () => {
        try {
          unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let pid: unknown;
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(file).mtimeMs;
      pid = JSON.parse(readFileSync(file, "utf8")).pid;
    } catch {
      /* vanished, or caught mid-write — judge by age alone */
    }
    const holderDead = typeof pid === "number" && !pidAlive(pid);
    if (!holderDead && ageMs <= staleMs) return undefined;
    try {
      unlinkSync(file);
    } catch {
      /* someone else broke it first */
    }
  }
  return undefined;
}

/** Is a process alive? (signal 0 probes without killing.) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Probe the MCP HTTP endpoint — any HTTP response means the server is up. */
export function httpReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    import("node:http")
      .then(({ request }) => {
        const req = request(url, { method: "GET", timeout: timeoutMs }, (res) => {
          res.resume(); // drain
          finish(true); // any status (even 400/404) means it's listening
        });
        req.on("error", () => finish(false));
        req.on("timeout", () => {
          req.destroy();
          finish(false);
        });
        req.end();
      })
      .catch(() => finish(false));
  });
}
