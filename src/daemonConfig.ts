/**
 * Pure config derivation for the daemon (#22) — parsing + defaulting the
 * DEVLOOP_* env vars, the advertised-URL rule, and the idle-shutdown predicate.
 * Kept dependency-free so it unit-tests without spinning up a real daemon
 * (runDaemon itself is all live wiring — browser, dev server, HTTP server).
 */

export interface DaemonConfig {
  logCapacity: number;
  headless: boolean;
  chromePath?: string;
  netThreshold: number;
  actionTimeoutMs: number;
  navTimeoutMs: number;
  port: number;
  idleMs: number;
  host: string;
  devCmd?: string;
  devCwd?: string;
}

/**
 * Parse a numeric env var, falling back on missing/empty/non-numeric input.
 * The raw `Number(process.env.X ?? d)` this replaces let `X=abc` become `NaN`
 * and silently propagate into a port/threshold/timeout.
 */
export function numEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function daemonConfigFromEnv(env: Record<string, string | undefined>): DaemonConfig {
  return {
    logCapacity: numEnv(env.DEVLOOP_LOG_CAPACITY, 5000),
    headless: env.DEVLOOP_HEADLESS !== "false", // default headless for a daemon
    chromePath: env.DEVLOOP_CHROME_PATH,
    netThreshold: numEnv(env.DEVLOOP_NET_THRESHOLD, 400),
    actionTimeoutMs: numEnv(env.DEVLOOP_ACTION_TIMEOUT, 10_000),
    navTimeoutMs: numEnv(env.DEVLOOP_NAV_TIMEOUT, 30_000),
    port: numEnv(env.DEVLOOP_HTTP_PORT, 7333),
    idleMs: numEnv(env.DEVLOOP_DAEMON_IDLE_MS, 0),
    // Loopback-only by default; DEVLOOP_HTTP_HOST=0.0.0.0 deliberately exposes it.
    host: env.DEVLOOP_HTTP_HOST || "127.0.0.1",
    devCmd: env.DEVLOOP_DEV_CMD,
    devCwd: env.DEVLOOP_DEV_CWD,
  };
}

/**
 * The URL to advertise to stdio clients / --status / --stop. `0.0.0.0` is a bind
 * address, not a reachable host, so advertise `localhost` in that case.
 */
export function advertisedUrl(host: string, port: number): string {
  return `http://${host === "0.0.0.0" ? "localhost" : host}:${port}/mcp`;
}

/** Idle-shutdown arms only when it's enabled (idleMs > 0) and no clients remain. */
export function shouldScheduleIdleShutdown(idleMs: number, count: number): boolean {
  return idleMs > 0 && count === 0;
}
