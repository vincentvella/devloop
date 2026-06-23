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
import { LogBuffer } from "./logBuffer.ts";
import { DevServer } from "./devServer.ts";
import { PuppeteerBrowserController } from "./browser.ts";
import { configureTools } from "./toolLayer.ts";
import { buildMcpServer } from "./mcpServer.ts";
import { startHttpMcp } from "./httpMcp.ts";

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
  const { server } = await startHttpMcp({ buildServer: () => buildMcpServer("devloop-daemon"), port, log });
  log("daemon ready — connect MCP clients via HTTP/SSE at /mcp");

  const shutdown = async () => {
    server.close();
    devServer.stop();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
