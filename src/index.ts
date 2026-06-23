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
 * Config via env: DEVLOOP_HEADLESS, DEVLOOP_CHROME_PATH, DEVLOOP_NET_THRESHOLD,
 * DEVLOOP_ACTION_TIMEOUT, DEVLOOP_NAV_TIMEOUT, DEVLOOP_LOG_CAPACITY, and the
 * optional boot auto-start DEVLOOP_DEV_CMD / DEVLOOP_DEV_CWD.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LogBuffer } from "./logBuffer.ts";
import { DevServer } from "./devServer.ts";
import { PuppeteerBrowserController } from "./browser.ts";
import { configureTools } from "./toolLayer.ts";
import { buildMcpServer } from "./mcpServer.ts";

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
  if (process.argv.slice(2).includes("daemon")) {
    const { runDaemon } = await import("./daemon.ts"); // long-running shared HTTP/SSE server (#22)
    await runDaemon();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  process.stderr.write(`[devloop] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
