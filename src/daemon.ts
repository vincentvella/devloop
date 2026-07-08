/**
 * devloop-mcp daemon (#22) — a long-running, headless Devloop that serves the MCP
 * tool layer over HTTP/SSE so MANY agents/sessions share ONE instance (one browser,
 * one dev server, one correlated timeline) instead of each spawning its own stdio
 * server. Run it once, then point MCP clients at its URL:
 *
 *   devloop-mcp daemon                       # starts on :7333 (or DEVLOOP_HTTP_PORT)
 *   # client config: { "type": "http", "url": "http://localhost:7333/mcp" }
 *
 * Same backend as the stdio entry (headless Puppeteer + a dev server), same env vars;
 * stderr is human-facing (no stdio MCP framing to protect here).
 */

import { PuppeteerBrowserController } from "./browser.ts";
import { clearDaemonState, httpReachable, pidAlive, readDaemonState, writeDaemonState } from "./daemonState.ts";
import { DevServer } from "./devServer.ts";
import { startHttpMcp } from "./httpMcp.ts";
import { LogBuffer } from "./logBuffer.ts";
import { buildMcpServer } from "./mcpServer.ts";
import { configureTools } from "./toolLayer.ts";

const log = (m: string) => process.stderr.write(`[devloop-daemon] ${m}\n`);

export async function runDaemon(): Promise<void> {
  const buffer = new LogBuffer(Number(process.env.DEVLOOP_LOG_CAPACITY ?? 5000));
  const devServer = new DevServer(buffer);
  const browser = new PuppeteerBrowserController(buffer, {
    headless: process.env.DEVLOOP_HEADLESS !== "false", // default headless for a daemon
    executablePath: process.env.DEVLOOP_CHROME_PATH,
    networkErrorThreshold: Number(process.env.DEVLOOP_NET_THRESHOLD ?? 400),
    actionTimeoutMs: Number(process.env.DEVLOOP_ACTION_TIMEOUT ?? 10_000),
    navTimeoutMs: Number(process.env.DEVLOOP_NAV_TIMEOUT ?? 30_000),
  });
  configureTools({ buffer, browser, devServer });

  try {
    await browser.start();
  } catch (err) {
    log(`WARN: browser failed to launch, browser tools will error: ${err}`);
  }
  if (process.env.DEVLOOP_DEV_CMD) {
    try {
      devServer.start(process.env.DEVLOOP_DEV_CMD, process.env.DEVLOOP_DEV_CWD ?? process.cwd());
    } catch (err) {
      log(`WARN: DEVLOOP_DEV_CMD auto-start failed: ${err}`);
    }
  }

  const port = Number(process.env.DEVLOOP_HTTP_PORT ?? 7333);

  // Optional idle-shutdown: exit once the last client disconnects (off by default).
  const idleMs = Number(process.env.DEVLOOP_DAEMON_IDLE_MS ?? 0);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Loopback-only by default; set DEVLOOP_HTTP_HOST=0.0.0.0 to deliberately expose a
  // shared daemon to the local network (understand the exposure before doing so).
  const host = process.env.DEVLOOP_HTTP_HOST || "127.0.0.1";

  const { server, port: bound } = await startHttpMcp({
    buildServer: () => buildMcpServer("devloop-daemon"),
    port,
    host,
    log,
    onSessionsChanged: (count) => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (idleMs > 0 && count === 0) {
        log(`no clients connected — idle shutdown in ${idleMs}ms`);
        idleTimer = setTimeout(() => void shutdown(), idleMs);
      }
    },
  });

  // Advertise ourselves so stdio clients (and --status/--stop) can find us.
  writeDaemonState({
    pid: process.pid,
    port: bound,
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${bound}/mcp`,
    startedAt: new Date().toISOString(),
  });
  log("daemon ready — connect MCP clients via HTTP/SSE at /mcp");

  const shutdown = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearDaemonState();
    server.close();
    devServer.stop();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** `daemon --status` — report whether a daemon is running (via the state file + probe). */
export async function daemonStatus(): Promise<void> {
  const s = readDaemonState();
  if (s && pidAlive(s.pid) && (await httpReachable(s.url))) {
    process.stdout.write(`devloop daemon running — pid ${s.pid}, ${s.url} (since ${s.startedAt})\n`);
  } else {
    if (s) clearDaemonState(); // stale
    process.stdout.write("devloop daemon not running\n");
  }
}

/** `daemon --stop` — SIGTERM a running daemon and clear its state. */
export async function daemonStop(): Promise<void> {
  const s = readDaemonState();
  if (!s || !pidAlive(s.pid)) {
    clearDaemonState();
    process.stdout.write("devloop daemon not running\n");
    return;
  }
  try {
    process.kill(s.pid, "SIGTERM");
    process.stdout.write(`stopped devloop daemon (pid ${s.pid})\n`);
  } catch (err) {
    process.stdout.write(`failed to stop daemon (pid ${s.pid}): ${err instanceof Error ? err.message : String(err)}\n`);
  }
  clearDaemonState();
}
