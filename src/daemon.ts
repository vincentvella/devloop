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
import { advertisedUrl, daemonConfigFromEnv, shouldScheduleIdleShutdown } from "./daemonConfig.ts";
import {
  clearDaemonState,
  daemonScope,
  httpReachable,
  pidAlive,
  readDaemonState,
  writeDaemonState,
} from "./daemonState.ts";
import { DevServer } from "./devServer.ts";
import { startHttpMcp } from "./httpMcp.ts";
import { LogBuffer } from "./logBuffer.ts";
import { buildMcpServer } from "./mcpServer.ts";
import { configureTools } from "./toolLayer.ts";

const log = (m: string) => process.stderr.write(`[devloop-daemon] ${m}\n`);

export async function runDaemon(): Promise<void> {
  // Never run two daemons for one scope (they'd fight over the state file, each with its
  // own Chrome). The spawn lock prevents this for auto-starts; this also covers manual runs.
  const rival = readDaemonState();
  if (rival && rival.pid !== process.pid && pidAlive(rival.pid) && (await httpReachable(rival.url))) {
    log(
      `a daemon is already running${rival.scope ? ` for ${rival.scope}` : ""} (pid ${rival.pid}, ${rival.url}) — exiting`,
    );
    process.exit(0);
  }
  const cfg = daemonConfigFromEnv(process.env);
  const buffer = new LogBuffer(cfg.logCapacity);
  const devServer = new DevServer(buffer);
  const browser = new PuppeteerBrowserController(buffer, {
    headless: cfg.headless,
    executablePath: cfg.chromePath,
    networkErrorThreshold: cfg.netThreshold,
    actionTimeoutMs: cfg.actionTimeoutMs,
    navTimeoutMs: cfg.navTimeoutMs,
  });
  configureTools({ buffer, browser, devServer });

  // Chrome is launched lazily by the first browser tool call (see browser.ts ensureLivePage).
  if (cfg.devCmd) {
    try {
      devServer.start(cfg.devCmd, cfg.devCwd ?? process.cwd());
    } catch (err) {
      log(`WARN: DEVLOOP_DEV_CMD auto-start failed: ${err}`);
    }
  }

  // Optional idle-shutdown: exit once the last client disconnects (off by default).
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const onSessionsChanged = (count: number) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (shouldScheduleIdleShutdown(cfg.idleMs, count)) {
      log(`no clients connected — idle shutdown in ${cfg.idleMs}ms`);
      idleTimer = setTimeout(() => void shutdown(), cfg.idleMs);
    }
  };

  const { server, port: bound } = await startHttpMcp({
    buildServer: () => buildMcpServer("devloop-daemon"),
    port: cfg.port,
    host: cfg.host,
    log,
    onSessionsChanged,
  });

  // Advertise ourselves so stdio clients (and --status/--stop) can find us.
  writeDaemonState({
    pid: process.pid,
    port: bound,
    url: advertisedUrl(cfg.host, bound),
    startedAt: new Date().toISOString(),
    scope: daemonScope(),
  });
  log("daemon ready — connect MCP clients via HTTP/SSE at /mcp");
  onSessionsChanged(0); // start counting now: the session that spawned us may never connect

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
    const scope = s.scope ? ` for ${s.scope}` : "";
    process.stdout.write(`devloop daemon running${scope} — pid ${s.pid}, ${s.url} (since ${s.startedAt})\n`);
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
