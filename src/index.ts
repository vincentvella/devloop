/**
 * devloop-mcp — CLI entry point.
 *
 * Default (stdio): drives Chrome via Puppeteer, spawns the dev server, and serves
 * the shared tool layer over stdio (the transport Claude Code spawns per session).
 *   `devloop-mcp daemon` instead runs a long-running, headless HTTP/SSE server that
 * many agents/sessions share (#22, see src/daemon.ts). The Electron cockpit reuses
 * the same tool layer over HTTP too.
 *
 * stdout is reserved for the MCP protocol. Everything human-facing → stderr.
 *
 * Shared mode (opt-in: `--shared` or DEVLOOP_DAEMON=1): instead of spawning its own
 * browser, the stdio launch bridges to a long-running daemon (auto-spawning one if
 * none is running) so many sessions share one browser/timeline (#round2.1). Falls
 * back to a local instance on any failure. Subcommands: `daemon`, `daemon --status`,
 * `daemon --stop`.
 *
 * Config via env: DEVLOOP_HEADLESS, DEVLOOP_CHROME_PATH, DEVLOOP_NET_THRESHOLD,
 * DEVLOOP_ACTION_TIMEOUT, DEVLOOP_NAV_TIMEOUT, DEVLOOP_LOG_CAPACITY, and the
 * optional boot auto-start DEVLOOP_DEV_CMD / DEVLOOP_DEV_CWD.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PuppeteerBrowserController } from "./browser.ts";
import { errorText } from "./crashReport.ts";
import { DevServer } from "./devServer.ts";
import { LogBuffer } from "./logBuffer.ts";
import { buildMcpServer } from "./mcpServer.ts";
import { configureTools } from "./toolLayer.ts";

async function runStdio(): Promise<void> {
  const buffer = new LogBuffer(Number(process.env.DEVLOOP_LOG_CAPACITY ?? 5000));
  const devServer = new DevServer(buffer);
  const browser = new PuppeteerBrowserController(buffer, {
    headless: process.env.DEVLOOP_HEADLESS === "true",
    executablePath: process.env.DEVLOOP_CHROME_PATH,
    networkErrorThreshold: Number(process.env.DEVLOOP_NET_THRESHOLD ?? 400),
    actionTimeoutMs: Number(process.env.DEVLOOP_ACTION_TIMEOUT ?? 10_000),
    navTimeoutMs: Number(process.env.DEVLOOP_NAV_TIMEOUT ?? 30_000),
  });
  configureTools({ buffer, browser, devServer });

  const shutdown = async () => {
    devServer.stop();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await browser.start();
  } catch (err) {
    process.stderr.write(`[devloop] WARN: browser failed to launch, browser tools will error: ${err}\n`);
  }
  if (process.env.DEVLOOP_DEV_CMD) {
    try {
      devServer.start(process.env.DEVLOOP_DEV_CMD, process.env.DEVLOOP_DEV_CWD ?? process.cwd());
    } catch (err) {
      process.stderr.write(`[devloop] WARN: DEVLOOP_DEV_CMD auto-start failed: ${err}\n`);
    }
  }
  await buildMcpServer().connect(new StdioServerTransport());
  process.stderr.write("[devloop] unified dev-loop MCP ready on stdio\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("daemon")) {
    const daemon = await import("./daemon.ts"); // long-running shared HTTP/SSE server (#22)
    if (args.includes("--status")) return daemon.daemonStatus();
    if (args.includes("--stop")) return daemon.daemonStop();
    return daemon.runDaemon();
  }

  // Shared mode (opt-in): bridge this stdio session to a daemon instead of spawning a
  // second browser. Auto-spawns a daemon if none is running; on any failure, fall back
  // to a normal local stdio instance so the session never just dies.
  const shared = args.includes("--shared") || process.env.DEVLOOP_DAEMON === "1";
  if (shared) {
    try {
      const { ensureDaemon, bridgeStdioToDaemon } = await import("./daemonClient.ts");
      const state = await ensureDaemon();
      await bridgeStdioToDaemon(state.url);
      return;
    } catch (err) {
      process.stderr.write(
        `[devloop] shared mode unavailable (${err instanceof Error ? err.message : err}); using a local instance\n`,
      );
    }
  }
  await runStdio();
}

main().catch((err) => {
  // errorText keeps the message even if a global stack formatter drops it from .stack.
  process.stderr.write(`[devloop] fatal: ${errorText(err)}\n`);
  process.exit(1);
});
