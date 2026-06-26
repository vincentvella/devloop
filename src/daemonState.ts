/**
 * Daemon discovery state — a tiny JSON file the daemon writes on boot so stdio
 * clients (and `daemon --status` / `--stop`) can find a running instance without
 * guessing ports. Lives at $DEVLOOP_HOME/daemon.json (default ~/.devloop). Pure
 * Node; mirrors registry.ts's lazy DEVLOOP_HOME resolution.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DaemonState {
  pid: number;
  port: number;
  url: string; // the MCP endpoint, e.g. http://localhost:7333/mcp
  startedAt: string; // ISO timestamp
}

const dir = (): string => process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop");
export const daemonStateFile = (): string => join(dir(), "daemon.json");

export function writeDaemonState(s: DaemonState): void {
  mkdirSync(dir(), { recursive: true });
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
