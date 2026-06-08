/**
 * devloop cockpit — Electron main process.
 *
 * Long-running desktop app that hosts the unified dev loop:
 *   - a "browser pane" window whose webContents IS the browser substrate
 *     (ElectronBrowserController drives it via CDP, feeding the shared buffer)
 *   - a "timeline" window rendering the unified server+browser event stream
 *   - the shared MCP tool layer served over HTTP, so Claude Code connects to a
 *     URL instead of spawning a per-project stdio server
 *
 * Run normally: `bun run app`
 * Headless self-check (no visible windows): `bun run app:selftest`
 */

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { join, dirname, resolve } from "node:path";

// The bundler inlines __dirname to the SOURCE dir, so derive the real output dir
// (where main.cjs/preload.cjs/renderer live) from the script Electron actually ran.
const BASE = dirname(resolve(process.argv[1] ?? "."));

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { LogBuffer } from "../src/logBuffer.ts";
import { DevServer, detectDevCommand } from "../src/devServer.ts";
import { TOOLS, handleTool, configureTools } from "../src/toolLayer.ts";
import { listProjects, addProject, getProject, getSession, setSession } from "../src/registry.ts";
import { BrowserManager } from "./browserManager.ts";

const PORT = Number(process.env.DEVLOOP_HTTP_PORT ?? 7333);
const SELFTEST = process.env.DEVLOOP_SELFTEST === "1";
let chosenPort = PORT;

const buffer = new LogBuffer(Number(process.env.DEVLOOP_LOG_CAPACITY ?? 5000));
const devServer = new DevServer(buffer);

let timelineWin: BrowserWindow | undefined;
let manager: BrowserManager;
let httpServer: ReturnType<typeof createServer> | undefined;
let cleanedUp = false;

// --- MCP over HTTP (stateful sessions) ------------------------------------
function buildMcpServer(): Server {
  const server = new Server({ name: "devloop-cockpit", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      return await handleTool(name, args as Record<string, unknown>);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function startHttp(): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const http = (httpServer = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport!),
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        await buildMcpServer().connect(transport);
      }
      if (!transport) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "no valid session" }));
      }
      return transport.handleRequest(req, res, body);
    }

    // GET (SSE stream) / DELETE (close) reuse an existing session
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.statusCode = 400;
      return res.end("invalid session");
    }
    return transport.handleRequest(req, res);
  }));

  // Bind to PORT, or the next free port if it's taken — so a stray instance
  // never wedges startup.
  for (let p = PORT; p < PORT + 10; p++) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      const onErr = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") resolve(false);
        else reject(err);
      };
      http.once("error", onErr);
      http.listen(p, () => {
        http.removeListener("error", onErr);
        chosenPort = p;
        resolve(true);
      });
    });
    if (bound) break;
  }
  log(`MCP over HTTP listening on http://localhost:${chosenPort}/mcp`);
}

// --- windows ---------------------------------------------------------------
function createWindows(): void {
  // Pane windows are owned by the BrowserManager; here we only create the timeline.
  timelineWin = new BrowserWindow({
    width: 560,
    height: 720,
    show: !SELFTEST,
    title: "devloop — timeline",
    webPreferences: {
      preload: join(BASE, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      offscreen: SELFTEST,
    },
  });
  // Surface renderer console + preload errors to the terminal (handy for debugging the UI).
  timelineWin.webContents.on("console-message", (...args: unknown[]) => {
    const msg = (args[2] as string) ?? (args[0] as { message?: string })?.message;
    log(`renderer: ${msg}`);
  });
  timelineWin.webContents.on("preload-error", (_e, path, err) => log(`preload-error ${path}: ${err}`));
  // The timeline is the control surface — closing it tears the whole app down.
  timelineWin.on("closed", () => app.quit());
  void timelineWin.loadFile(join(BASE, "renderer/index.html"));

  // Stream live events to the timeline window.
  buffer.onPush((e) => timelineWin?.webContents.send("devloop:push", e));
}

// --- IPC for the timeline renderer ----------------------------------------
function wireIpc(): void {
  ipcMain.handle("devloop:getLogs", (_e, opts) => buffer.query(opts ?? {}));
  ipcMain.handle("devloop:devStatus", () => devServer.status());
  ipcMain.handle("devloop:clear", () => {
    buffer.clear();
    return true;
  });
  ipcMain.handle("devloop:navigate", (_e, url: string) => manager.navigate(url));
  ipcMain.handle("devloop:devStart", (_e, opts: { cmd?: string; cwd?: string }) => {
    const cwd = opts?.cwd || process.cwd();
    const cmd = opts?.cmd || detectDevCommand(cwd);
    return devServer.start(cmd, cwd);
  });
  ipcMain.handle("devloop:devStop", () => devServer.stop());
  ipcMain.handle("devloop:pickFolder", async () => {
    const r = await dialog.showOpenDialog(timelineWin!, { properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  // Project registry
  ipcMain.handle("devloop:projects", () => listProjects());
  ipcMain.handle("devloop:projectAdd", (_e, p) => addProject(p));
  // Multi-target panes
  ipcMain.handle("devloop:panes", () => manager.listPanes());
  ipcMain.handle("devloop:paneNew", (_e, url?: string) => manager.newPane(url));
  ipcMain.handle("devloop:paneSelect", (_e, id: string) => manager.selectPane(id));
  ipcMain.handle("devloop:paneClose", (_e, id: string) => manager.closePane(id));

  // Session: last-used setup, restored on relaunch.
  ipcMain.handle("devloop:session", () => getSession());
  ipcMain.handle("devloop:sessionSave", (_e, s) => setSession(s));

  // Repro builder — run an action sequence through the shared tool layer.
  ipcMain.handle("devloop:repro", async (_e, args) => {
    const res = await handleTool("repro", args ?? {});
    return JSON.parse((res.content[0] as { text: string }).text);
  });

  ipcMain.handle("devloop:openProject", async (_e, name: string) => {
    const p = getProject(name);
    if (!p) throw new Error(`no saved project "${name}"`);
    if (!devServer.status().running) devServer.start(p.cmd || detectDevCommand(p.cwd), p.cwd);
    if (p.url) await manager.navigate(p.url);
    return { dev: devServer.status(), url: p.url ?? null };
  });
}

const WELCOME =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<html><body style="margin:0;font:14px ui-monospace,monospace;background:#0d1117;color:#8b949e;display:grid;place-items:center;height:100vh"><div style="text-align:center"><div style="font-size:18px;color:#c9d1d9">devloop — app pane</div><div style="margin-top:8px">Enter a URL in the timeline window's bar, or dev_start a project.</div></div></body></html>`,
  );

function log(msg: string): void {
  process.stderr.write(`[cockpit] ${msg}\n`);
}

// --- boot ------------------------------------------------------------------
async function main() {
  if (SELFTEST) {
    app.dock?.hide();
    // Watchdog: never let a headless run hang the harness.
    setTimeout(() => {
      log("SELFTEST watchdog: timed out, exiting");
      app.exit(2);
    }, 30_000);
  }
  log("waiting for app ready…");
  await app.whenReady();
  log("app ready; creating windows");
  createWindows();
  wireIpc();
  log("starting browser manager (first pane)");

  manager = new BrowserManager(
    buffer,
    {
      networkErrorThreshold: Number(process.env.DEVLOOP_NET_THRESHOLD ?? 400),
      actionTimeoutMs: Number(process.env.DEVLOOP_ACTION_TIMEOUT ?? 10_000),
    },
    SELFTEST,
  );
  manager.onChange = () => timelineWin?.webContents.send("devloop:panesChanged");
  await manager.start();
  log("manager started");
  configureTools({ buffer, browser: manager, devServer });

  await startHttp();
  log("ready");

  if (SELFTEST) {
    await runSelfTest();
  } else {
    await manager.navigate(WELCOME); // give the first pane something instead of about:blank
  }
}

// --- headless self-check ---------------------------------------------------
async function runSelfTest() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  // 1) substrate -> buffer (console object rendered synchronously from CDP)
  await manager.navigate(
    `data:text/html,<button id=go onclick="console.log('cockpit', {ok:true})">go</button><script>console.log('hi', {n:1});fetch('http://localhost:59999/x').catch(()=>{})</script>`,
  );
  await new Promise((r) => setTimeout(r, 600));
  const logs = buffer.query({ source: "browser" });
  console.log("SELFTEST buffer (browser):");
  for (const e of logs) console.log(`  [${e.stream}] ${e.line}`);

  // 2) tool layer over the Electron substrate
  const clickRes = await handleTool("repro", { action: { kind: "click", selector: "#go" }, settleMs: 300, clear: false });
  const clicked = JSON.parse((clickRes.content[0] as any).text);
  console.log(`SELFTEST repro click: stepCount=${clicked.stepCount} errorCount=${clicked.errorCount}`);

  // 3) MCP over HTTP handshake + tools/list
  const client = new Client({ name: "selftest", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${chosenPort}/mcp`)));
  const t = await client.listTools();
  console.log(`SELFTEST MCP/HTTP tools: ${t.tools.length} (${t.tools.map((x) => x.name).join(", ")})`);
  await client.close();

  // 4) RENDERER path: preload API present, and a renderer-initiated navigate reaches the buffer
  const tl = timelineWin!.webContents;
  for (let i = 0; i < 50 && tl.isLoading(); i++) await new Promise((r) => setTimeout(r, 100));
  const api = await tl.executeJavaScript("typeof window.devloop");
  const methods = await tl.executeJavaScript(
    "window.devloop ? Object.keys(window.devloop).join(',') : 'NONE'",
  );
  console.log(`SELFTEST renderer api=${api} methods=${methods}`);
  const navJson = await tl.executeJavaScript(
    "window.devloop.navigate('data:text/html,<script>console.log(\\'from-renderer-nav\\')</script>').then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e.message)",
  );
  console.log(`SELFTEST renderer navigate -> ${navJson}`);
  await new Promise((r) => setTimeout(r, 400));
  const got = buffer.query({}).some((e) => e.line.includes("from-renderer-nav"));
  console.log(`SELFTEST renderer->buffer flowed: ${got}`);

  // 5) project registry: add via tool layer, confirm tool + renderer both see it
  await handleTool("project_add", { name: "selftest-proj", cwd: process.cwd(), url: "about:blank" });
  const plist = JSON.parse((await handleTool("project_list")).content[0]!.text as string) as {
    projects: { name: string }[];
  };
  const inTool = plist.projects.some((p) => p.name === "selftest-proj");
  const rendererSees = (await tl.executeJavaScript(
    "window.devloop.projects().then(ps=>ps.map(p=>p.name).join(','))",
  )) as string;
  console.log(`SELFTEST registry: tool=${inTool} rendererSees="${rendererSees}"`);

  // 6) multi-target: open a 2nd pane, navigate it, assert events are tagged per-pane
  const pane2 = JSON.parse((await handleTool("pane_new", { url: "about:blank" })).content[0]!.text as string);
  await manager.navigate("data:text/html,<script>console.log('in-pane-2')</script>"); // active = pane2
  await new Promise((r) => setTimeout(r, 300));
  const paneList = JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
    panes: { id: string }[];
  };
  const p2Event = buffer.query({}).find((e) => e.line.includes("in-pane-2"));
  const taggedRight = p2Event?.target === pane2.id;
  console.log(`SELFTEST panes: count=${paneList.panes.length} pane2=${pane2.id} eventTarget=${p2Event?.target} tagged=${taggedRight}`);

  // 7) repro builder: drive the real "run ▶" button, confirm inline render + session persistence
  const builder = (await tl.executeJavaScript(`(async () => {
    const steps = document.getElementById('steps');
    const sel = steps.querySelector('select'); const inp = steps.querySelector('input');
    sel.value = 'navigate'; sel.dispatchEvent(new Event('change'));
    inp.value = "data:text/html,<title>x</title>";
    document.getElementById('runrepro').click();
    await new Promise(r=>setTimeout(r,2000));
    const listText = document.getElementById('list').textContent || '';
    const sess = await window.devloop.session();
    return JSON.stringify({ inlineRendered: listText.includes('▶ repro'), sessionSteps: (sess.steps||[]).length });
  })()`)) as string;
  console.log(`SELFTEST repro builder -> ${builder}`);
  const b = JSON.parse(builder);
  const builderOk = b.inlineRendered === true && b.sessionSteps >= 1;

  // 8) start a sentinel dev server; app.quit() (below) must kill its whole group.
  const ds = JSON.parse(
    (await handleTool("dev_start", { cmd: "sleep 6017", cwd: process.cwd() })).content[0]!.text as string,
  );
  console.log(`SELFTEST devserver pid=${ds.pid} (sentinel 'sleep 6017' must die on quit)`);
  await new Promise((r) => setTimeout(r, 300));

  const ok =
    api === "object" &&
    got &&
    inTool &&
    rendererSees.includes("selftest-proj") &&
    paneList.panes.length >= 2 &&
    taggedRight &&
    builderOk;
  console.log(ok ? "SELFTEST OK" : "SELFTEST FAIL");
  app.quit();
}

/** Kill everything we started: dev-server process group, browser panes, HTTP server. */
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    devServer.stop();
  } catch (e) {
    log(`cleanup devServer: ${e}`);
  }
  try {
    void manager?.close();
  } catch (e) {
    log(`cleanup manager: ${e}`);
  }
  try {
    httpServer?.close();
  } catch (e) {
    log(`cleanup http: ${e}`);
  }
  log("cleaned up (dev server, panes, http)");
}

app.on("before-quit", cleanup);
app.on("window-all-closed", () => app.quit());
process.on("SIGTERM", () => {
  cleanup();
  app.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  app.exit(0);
});
main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  cleanup();
  app.exit(1);
});
