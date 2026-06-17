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

// Silence Electron's dev-only "Insecure Content-Security-Policy" warning that it
// injects into every renderer — it's about the dev target's page, not our app,
// and it just spams the timeline. (Set before any window/view is created.)
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

import { app, BrowserWindow, ipcMain, dialog, nativeImage, session } from "electron";
import { createServer, type IncomingMessage } from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mergePath, parseShellPath } from "../src/shellPath.ts";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { installExtension, uninstallExtension, loadAllExtensions, installChromeWebStore } from "electron-chrome-web-store";
import { extensionIdFromInput, unifyExtensions, type ExtMeta } from "../src/extensions.ts";
import { getUnpackedExtensions, setUnpackedExtensions, getDisabledExtensions, setDisabledExtensions } from "../src/registry.ts";
import { PANE_PARTITION } from "./browserManager.ts";

// Where main.cjs/preload.cjs/renderer live. Bun inlines __dirname to the SOURCE dir,
// so we can't use it. Packaged: <app.asar>/out via getAppPath(). Dev (`electron
// out/main.cjs`): the dir of the script Electron actually ran.
const BASE = app.isPackaged ? join(app.getAppPath(), "out") : dirname(resolve(process.argv[1] ?? "."));

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { LogBuffer } from "../src/logBuffer.ts";
import { projectName, type DevServerLike } from "../src/devServer.ts";
import { TOOLS, handleTool, configureTools } from "../src/toolLayer.ts";
import { listProjects, addProject, getProject, getSession, setSession, getPanes, getProjectFingerprint } from "../src/registry.ts";
import { bundleToHtml } from "../src/bundle.ts";
import { detectTargetKind } from "../src/target.ts";
import { resolveNativeInfo, type Platform } from "../src/nativeBuild.ts";
import { runNativeBuild, computeFingerprint } from "../src/nativeBuildRunner.ts";
import { BrowserManager } from "./browserManager.ts";
import { initAutoUpdate, type Updater } from "./updater.ts";
import { ServeSim } from "./serveSim.ts";
import { NativeObservability } from "./nativeObservability.ts";
import { metroBaseFromUrl, deriveAppMatch } from "../src/nativeObservability.ts";

const PORT = Number(process.env.DEVLOOP_HTTP_PORT ?? 7333);
const SELFTEST = process.env.DEVLOOP_SELFTEST === "1";
let chosenPort = PORT;

const buffer = new LogBuffer(Number(process.env.DEVLOOP_LOG_CAPACITY ?? 5000));

let shellWin: BrowserWindow | undefined;
let manager: BrowserManager;
let updater: Updater | undefined;
const serveSim = new ServeSim(log);
const observability = new NativeObservability(buffer, log);

/**
 * Import the login-shell PATH into a packaged GUI app. Launched from Finder/Dock,
 * a macOS app gets a minimal PATH without bun/node/expo/Homebrew — so spawned dev
 * tooling (serve-sim, expo, dev servers) wouldn't be found. Skipped in dev (run
 * from a terminal, PATH already correct) and on Windows.
 */
function importShellPath(): void {
  if (process.platform === "win32" || !app.isPackaged) return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__DEVLOOP_PATH__";
    const out = execFileSync(shell, ["-lic", `printf '%s' '${marker}'; printf '%s' "$PATH"`], { encoding: "utf8", timeout: 4000 });
    const got = parseShellPath(out, marker);
    if (got) {
      process.env.PATH = mergePath(process.env.PATH, got);
      log(`imported login-shell PATH (${got.split(":").length} entries)`);
    }
  } catch (e) {
    log(`shell PATH import failed: ${(e as Error).message}`);
  }
}

/** Best-effort native-log process match from a project's Expo config. */
function appMatchFor(cwd: string): string {
  let cfg: { name?: string; expo?: { name?: string } } | null = null;
  try {
    cfg = JSON.parse(readFileSync(join(cwd, "app.json"), "utf8"));
  } catch {
    /* app.config.ts or none → fall back to dir name */
  }
  return deriveAppMatch(cfg, cwd);
}
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
      res.setHeader("Access-Control-Allow-Origin", "*"); // so cross-origin probes get the response
      res.setHeader("Content-Type", "text/html; charset=utf-8"); // an HTML doc so content scripts inject
      return res.end("<!doctype html><title>404</title>not found");
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
  // One shell window: the renderer (toolbar + timeline) plus embedded pane views.
  shellWin = new BrowserWindow({
    width: 1280,
    height: 940, // taller default so the tall simulator (phone aspect) has room in the pane
    show: !SELFTEST,
    title: "Devloop",
    icon: [join(BASE, "../assets/icon.png"), join(BASE, "assets/icon.png")].find(existsSync),
    webPreferences: {
      preload: join(BASE, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      offscreen: SELFTEST,
    },
  });
  // Surface renderer console + preload errors to the terminal (handy for debugging the UI).
  shellWin.webContents.on("console-message", (...args: unknown[]) => {
    const msg = (args[2] as string) ?? (args[0] as { message?: string })?.message;
    log(`renderer: ${msg}`);
  });
  shellWin.webContents.on("preload-error", (_e, path, err) => log(`preload-error ${path}: ${err}`));
  // The timeline is the control surface — closing it tears the whole app down.
  shellWin.on("closed", () => quitHard());
  void shellWin.loadFile(join(BASE, "renderer/index.html"));

  // Stream live events to the timeline window.
  buffer.onPush((e) => shellWin?.webContents.send("devloop:push", e));
}

// --- IPC for the timeline renderer ----------------------------------------
function wireIpc(): void {
  ipcMain.handle("devloop:getLogs", (_e, opts) => buffer.query(opts ?? {}));
  ipcMain.handle("devloop:clear", () => {
    buffer.clear();
    return true;
  });
  ipcMain.handle("devloop:navigate", (_e, url: string) => manager.navigate(url));
  ipcMain.handle("devloop:checkForUpdates", () => updater?.check(true));
  ipcMain.handle("devloop:openExtensions", () => openExtensionsWindow());
  ipcMain.handle("devloop:nativeInfo", (_e, cwd: string) => nativeInfo(cwd));
  ipcMain.handle("devloop:nativeBuild", (_e, cwd: string, platform: Platform) => {
    if (!cwd || !platform) return { started: false };
    runNativeBuild({ buffer, projectRoot: cwd, platform }); // streams to the timeline; fingerprint recorded on success
    return { started: true };
  });
  // Simulator: a serve-sim child window overlaying the pane area (see simulatorWindow.ts).
  ipcMain.handle("devloop:openSimulator", async () => {
    // serve-sim captures the booted sim; we load its interactive preview mode in a
    // pane view (MJPEG <img> + input layer → composites + interactive; no overlay window).
    const info = await serveSim.ensure();
    if (!info) {
      log("simulator: serve-sim has no booted device (boot a simulator first)");
      return { ok: false };
    }
    await manager.setSimulatorActive(true, info);
    // Stream the native app's JS + native logs onto the timeline (scoped to its pane).
    const active = manager.listPanes().find((p) => p.active);
    const metroBase = metroBaseFromUrl(active?.url);
    if (active && metroBase) {
      observability.attach({ paneId: active.id, metroBase, device: "booted", appMatch: active.dev?.cwd ? appMatchFor(active.dev.cwd) : undefined });
    } else {
      log("simulator: no Metro URL on the active pane — start its bundler to stream JS logs");
    }
    return { ok: true };
  });
  ipcMain.handle("devloop:closeSimulator", async () => {
    await manager.setSimulatorActive(false);
    observability.detachAll();
    return { ok: true };
  });

  // Per-pane dev lifecycle (top-bar controls act on the active pane).
  ipcMain.handle("devloop:devStatus", () => manager.devStatus());
  ipcMain.handle("devloop:devStart", async (_e, opts: { cmd?: string; cwd?: string }) => {
    await manager.ensureActive();
    return manager.devStart(undefined, opts?.cmd || undefined, opts?.cwd || undefined);
  });
  ipcMain.handle("devloop:devStop", () => manager.devStop());
  ipcMain.handle("devloop:devRestart", () => manager.devRestart());
  ipcMain.handle("devloop:setDevConfig", async (_e, opts: { cmd?: string; cwd?: string }) => {
    await manager.ensureActive();
    return manager.setDevConfig(undefined, opts?.cmd || undefined, opts?.cwd || undefined);
  });
  ipcMain.handle("devloop:reload", (_e, hard: boolean) => manager.reload(undefined, !!hard));
  ipcMain.handle("devloop:back", () => manager.back());
  ipcMain.handle("devloop:forward", () => manager.forward());
  // pane-targeted (popped windows drive their own pane)
  ipcMain.handle("devloop:navigateFor", (_e, id: string, url: string) => manager.navigateFor(id, url));
  ipcMain.handle("devloop:backFor", (_e, id: string) => manager.backFor(id));
  ipcMain.handle("devloop:forwardFor", (_e, id: string) => manager.forwardFor(id));
  ipcMain.handle("devloop:reloadFor", (_e, id: string, hard: boolean) => manager.reload(id, !!hard));
  ipcMain.handle("devloop:setBoundsFor", (_e, id: string, rect) => manager.setBoundsFor(id, rect));
  ipcMain.handle("devloop:screenshotFor", async (_e, id: string) => {
    const shot = await manager.screenshotFor(id);
    if (shot.base64) buffer.push("browser", "screenshot", "screenshot", { image: `data:${shot.mimeType};base64,${shot.base64}` }, id);
  });
  ipcMain.handle("devloop:pick", () => manager.pick());
  ipcMain.handle("devloop:clearStorage", (_e, opts) => manager.clearStorage(opts));
  ipcMain.handle("devloop:exportHar", async () => {
    const res = await handleTool("export_har", {});
    const har = (res.content[0] as { text?: string })?.text ?? "{}";
    const { canceled, filePath } = await dialog.showSaveDialog(shellWin!, {
      defaultPath: "devloop.har",
      filters: [{ name: "HAR", extensions: ["har"] }],
    });
    if (canceled || !filePath) return null;
    writeFileSync(filePath, har);
    return filePath;
  });
  ipcMain.handle("devloop:exportBundle", async () => {
    const res = await handleTool("export_bundle", {});
    const bundle = JSON.parse((res.content[0] as { text?: string })?.text ?? "{}");
    const html = bundleToHtml(bundle);
    const { canceled, filePath } = await dialog.showSaveDialog(shellWin!, {
      defaultPath: "devloop-report.html",
      filters: [{ name: "HTML report", extensions: ["html"] }],
    });
    if (canceled || !filePath) return null;
    writeFileSync(filePath, html);
    return filePath;
  });
  // --- extensions ---
  ipcMain.handle("devloop:extList", () => extList());
  ipcMain.handle("devloop:extInstall", async (_e, input: string) => {
    const id = extensionIdFromInput(String(input));
    if (!id) throw new Error("not a valid extension id or Chrome Web Store URL");
    await installExtension(id, { session: extSession(), extensionsPath: EXT_DIR });
    return extList();
  });
  ipcMain.handle("devloop:extLoadUnpacked", async () => {
    const r = await dialog.showOpenDialog(shellWin!, { properties: ["openDirectory"], title: "Select an unpacked extension folder" });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const ext = await extSession().extensions.loadExtension(dir, { allowFileAccess: true });
    unpackedById.set(ext.id, dir);
    setUnpackedExtensions([...getUnpackedExtensions(), dir]);
    return extList();
  });
  // Toggle an extension on/off without uninstalling — disable unloads it from the
  // session (files stay); enable reloads it from disk. Persisted across launches.
  ipcMain.handle("devloop:extSetEnabled", async (_e, id: string, enabled: boolean) => {
    const disabled = new Set(getDisabledExtensions());
    if (enabled) {
      const dir = extDir(id);
      if (dir) {
        try {
          await extSession().extensions.loadExtension(dir, { allowFileAccess: true });
        } catch (e) {
          log(`extensions: enable failed (${id}): ${e}`);
        }
      }
      disabled.delete(id);
    } else {
      try {
        extSession().extensions.removeExtension(id);
      } catch {
        /* already unloaded */
      }
      disabled.add(id);
    }
    setDisabledExtensions([...disabled]);
    return extList();
  });
  ipcMain.handle("devloop:extRemove", async (_e, id: string) => {
    setDisabledExtensions(getDisabledExtensions().filter((x) => x !== id)); // forget any disabled flag
    try {
      extSession().extensions.removeExtension(id);
    } catch {
      /* not loaded */
    }
    if (unpackedById.has(id)) {
      const dir = unpackedById.get(id)!;
      unpackedById.delete(id);
      setUnpackedExtensions(getUnpackedExtensions().filter((p) => p !== dir));
    } else {
      try {
        await uninstallExtension(id, { session: extSession(), extensionsPath: EXT_DIR });
      } catch {
        /* store uninstall best-effort */
      }
    }
    return extList();
  });
  ipcMain.handle("devloop:screenshot", async () => {
    const shot = await manager.screenshot(false);
    const active = manager.listPanes().find((p) => p.active);
    buffer.push("browser", "screenshot", "screenshot", { image: `data:${shot.mimeType};base64,${shot.base64}` }, active?.id);
  });

  ipcMain.handle("devloop:pickFolder", async () => {
    const r = await dialog.showOpenDialog(shellWin!, { properties: ["openDirectory"] });
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
  ipcMain.handle("devloop:panePop", (_e, id: string) => manager.popPane(id));
  ipcMain.handle("devloop:paneSetLabel", (_e, id: string, label: string) => manager.setLabel(id, label));
  // Renderer reports the #browserarea rect; reposition the embedded active pane.
  ipcMain.handle("devloop:setBounds", (_e, rect) => manager.setBounds(rect));
  ipcMain.handle("devloop:overlay", (_e, on: boolean) => {
    return manager.setOverlay(!!on);
  });

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
    await manager.ensureActive(); // open into a pane even if all were closed
    const label = projectName(p.cwd);
    // Configure + start this project on the ACTIVE pane; auto-navigate (or use saved url).
    manager.setDevConfig(undefined, p.cmd, p.cwd);
    if (manager.devStatus().running) manager.devRestart();
    else manager.devStart(undefined, p.cmd, p.cwd);
    if (p.url) await manager.navigate(p.url);
    return { dev: manager.devStatus(), url: p.url ?? null, name: label };
  });
}

const WELCOME =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<html><body style="margin:0;font:14px ui-monospace,monospace;background:#0d1117;color:#8b949e;display:grid;place-items:center;height:100vh"><div style="text-align:center"><div style="font-size:18px;color:#c9d1d9">Devloop — app pane</div><div style="margin-top:8px">Enter a URL in the timeline window's bar, or dev_start a project.</div></div></body></html>`,
  );

function log(msg: string): void {
  process.stderr.write(`[cockpit] ${msg}\n`);
}

// --- chrome extensions (loaded into the panes' session, not the shell's) ---
const EXT_DIR = join(process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop"), "extensions");
const WEB_STORE_URL = "https://chromewebstore.google.com/";
const unpackedById = new Map<string, string>(); // loaded unpacked extension id → source dir
const extSession = () => session.fromPartition(PANE_PARTITION);
let extWin: BrowserWindow | undefined;

/**
 * Browse the real Chrome Web Store in its own window (not a project pane — panes
 * carry the timeline). It uses the panes' session, so the preload + "Add to
 * Chrome" interception set up by installChromeWebStore apply and installs land
 * in the same session our panes use.
 */
function openExtensionsWindow(): void {
  if (extWin && !extWin.isDestroyed()) {
    extWin.focus();
    return;
  }
  extWin = new BrowserWindow({
    // The Web Store layout has a ~1248px min-width before it reflows; below that
    // it scrolls horizontally (real Chrome does too). useContentSize makes these
    // the web viewport dimensions (not the outer frame), so the page actually fits.
    width: 1280,
    height: 860,
    minWidth: 1024,
    useContentSize: true,
    center: true,
    title: "Devloop — Extensions",
    icon: [join(BASE, "../assets/icon.png"), join(BASE, "assets/icon.png")].find(existsSync),
    webPreferences: { partition: PANE_PARTITION, contextIsolation: true, sandbox: false },
  });
  extWin.on("closed", () => (extWin = undefined));
  void extWin.loadURL(WEB_STORE_URL);
}
/** Directory to (re)load an extension from: a tracked unpacked path, else the
 * web-store version dir under EXT_DIR/<id>/<version>. undefined if not found. */
function extDir(id: string): string | undefined {
  const up = unpackedById.get(id);
  if (up && existsSync(join(up, "manifest.json"))) return up;
  const base = join(EXT_DIR, id);
  try {
    for (const v of readdirSync(base)) {
      const d = join(base, v);
      if (existsSync(join(d, "manifest.json"))) return d;
    }
  } catch {
    /* not installed */
  }
  return undefined;
}

/** Read a disabled extension's name/version from disk (it isn't loaded). */
function extMeta(id: string): ExtMeta | null {
  const dir = extDir(id);
  if (!dir) return null;
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    return { id, name: m.name ?? id, version: m.version ?? "?" };
  } catch {
    return null;
  }
}

/** Loaded extensions (enabled) + known-disabled ones, for the UI's toggle list. */
const extList = () => {
  const loaded = extSession().extensions.getAllExtensions().map((e) => ({ id: e.id, name: e.name, version: e.version }));
  const disabled = getDisabledExtensions().map(extMeta).filter((m): m is ExtMeta => !!m);
  return unifyExtensions(loaded, disabled);
};

async function initExtensions(): Promise<void> {
  const ses = extSession();
  // Enable the real Chrome Web Store inside our panes' session: this intercepts
  // the store's "Add to Chrome" button and installs into EXT_DIR. It registers
  // its own preload (chrome-web-store.preload.js, copied beside main.cjs by the
  // build) into this session. loadExtensions:false — we load persisted ones below.
  try {
    await installChromeWebStore({ session: ses, extensionsPath: EXT_DIR, loadExtensions: false, allowUnpackedExtensions: true });
  } catch (e) {
    log(`extensions: web store setup failed: ${e}`);
  }
  // Surface store installs (Add to Chrome) to the renderer so the list stays live.
  ses.extensions.on("extension-loaded", () => shellWin?.webContents.send("devloop:extChanged"));
  ses.extensions.on("extension-unloaded", () => shellWin?.webContents.send("devloop:extChanged"));
  try {
    await loadAllExtensions(ses, EXT_DIR, { allowUnpacked: true }); // store extensions persisted under EXT_DIR
  } catch (e) {
    log(`extensions: store load failed: ${e}`);
  }
  for (const dir of getUnpackedExtensions()) {
    try {
      const ext = await ses.extensions.loadExtension(dir, { allowFileAccess: true });
      unpackedById.set(ext.id, dir);
    } catch (e) {
      log(`extensions: unpacked reload failed (${dir}): ${e}`);
    }
  }
  // Unload extensions the user toggled off (loadAllExtensions loaded everything).
  for (const id of getDisabledExtensions()) {
    try {
      ses.extensions.removeExtension(id);
    } catch {
      /* not loaded */
    }
  }
}

/**
 * Probe a project dir for native-build info (is it Expo/RN, which platforms,
 * is the installed binary stale). Composes the pure resolveNativeInfo with fs +
 * fingerprint reads. Fingerprint compute is ~1s; called when the wrench opens.
 */
async function nativeInfo(cwd: string) {
  if (!cwd || !existsSync(cwd)) return { isNative: false, platforms: [], buildStatus: "unknown", badge: null };
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    /* no package.json → web */
  }
  const probe = { hasIosDir: existsSync(join(cwd, "ios")), hasAndroidDir: existsSync(join(cwd, "android")) };
  const kind = detectTargetKind({ dependencies: deps, ...probe });
  if (kind !== "react-native") return { isNative: false, platforms: [], targets: [], buildStatus: "unknown", badge: null };
  const webCapable = !!(deps["expo"] || deps["react-native-web"]); // Expo / RNW → has a Web target
  const current = await computeFingerprint(cwd);
  return resolveNativeInfo(kind, probe, current, getProjectFingerprint(cwd), webCapable);
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
  app.setName("Devloop");
  importShellPath(); // before any spawn (dev servers, serve-sim) so bun/node/expo are found
  log("waiting for app ready…");
  await app.whenReady();
  // Dock/taskbar icon in dev (packaged builds get it from electron-builder).
  // Icons live beside the repo root; in a packaged app they're under resources.
  const iconPng = [join(BASE, "../assets/icon.png"), join(BASE, "assets/icon.png")].find(existsSync);
  if (iconPng && process.platform === "darwin" && app.dock) app.dock.setIcon(nativeImage.createFromPath(iconPng));
  log("app ready; creating windows");
  createWindows();
  wireIpc();
  // Auto-update: check GitHub on launch (packaged + signed builds only) and prompt.
  updater = initAutoUpdate({ win: shellWin, log, enabled: app.isPackaged && !SELFTEST });
  void updater.check();
  await initExtensions(); // load extensions into the panes' session before panes navigate
  log("starting browser manager (first pane)");

  manager = new BrowserManager(
    buffer,
    {
      networkErrorThreshold: Number(process.env.DEVLOOP_NET_THRESHOLD ?? 400),
      actionTimeoutMs: Number(process.env.DEVLOOP_ACTION_TIMEOUT ?? 10_000),
    },
    SELFTEST,
    { indexPath: join(BASE, "renderer/index.html"), preloadPath: join(BASE, "preload.cjs"), simPreloadPath: join(BASE, "simPreload.cjs") },
  );
  manager.attachTo(shellWin!);
  manager.onChange = () => {
    if (shellWin && !shellWin.isDestroyed()) shellWin.webContents.send("devloop:panesChanged");
  };
  await manager.start();
  log("manager started");
  if (SELFTEST) {
    const ps = manager.listPanes();
    const persisted0 = getPanes().panes[0];
    console.log(
      `SELFTEST restored ${ps.length} pane(s); anyDevRunning=${ps.some((p) => p.dev?.running)}; persistedUrl0=${persisted0?.url}`,
    );
  }

  // The tool layer's dev_* tools act on the ACTIVE pane's dev server.
  const devFacade: DevServerLike = {
    start: (cmd, cwd) => manager.devStart(undefined, cmd, cwd),
    stop: () => manager.devStop(),
    status: () => manager.devStatus(),
  };
  configureTools({ buffer, browser: manager, devServer: devFacade });

  await startHttp();
  log("ready");

  if (SELFTEST) {
    await runSelfTest();
  } else if (manager.currentUrl() === "about:blank") {
    await manager.navigate(WELCOME); // only on a fresh pane — restored panes keep their URL
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

  // 3) MCP over HTTP — the real remote-Claude surface: handshake, tools/list, AND run a repro.
  const client = new Client({ name: "selftest", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${chosenPort}/mcp`)));
  const t = await client.listTools();
  console.log(`SELFTEST MCP/HTTP tools: ${t.tools.length} (${t.tools.map((x) => x.name).join(", ")})`);

  // Set up and run a repro entirely over MCP-over-HTTP, then read it back.
  const reproRes = (await client.callTool({
    name: "repro",
    arguments: {
      action: {
        kind: "navigate",
        url: `data:text/html,<script>console.error('mcp-repro-err');fetch('http://localhost:${chosenPort}/nope').catch(()=>{})</script>`,
      },
      waitFor: "networkidle",
      idleMs: 400,
      timeoutMs: 5000,
    },
  })) as { content: Array<{ type: string; text?: string }> };
  const reproData = JSON.parse(reproRes.content.find((c) => c.type === "text")!.text!) as {
    stepCount: number;
    errorCount: number;
    errors: { line: string }[];
  };
  const mcpReproOk = reproData.stepCount === 1 && reproData.errorCount >= 1;
  console.log(`SELFTEST MCP repro: steps=${reproData.stepCount} errors=${reproData.errorCount} ok=${mcpReproOk}`);
  await client.close();

  // 4) RENDERER path: preload API present, and a renderer-initiated navigate reaches the buffer
  const tl = shellWin!.webContents;
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

  // 6a) persistence: the open panes should be saved (for restore on relaunch)
  const persistedCount = getPanes().panes.length;
  const persistOk = persistedCount >= 2;
  console.log(`SELFTEST persisted panes: ${persistedCount}`);

  // 6b) pop-out: detach pane-2 into its own window; pane_list should flag it popped
  await handleTool("pane_pop", { id: pane2.id });
  const afterPop = JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
    panes: { id: string; popped?: boolean }[];
  };
  const poppedInfo = afterPop.panes.find((p) => p.id === pane2.id) as { popped?: boolean; active?: boolean } | undefined;
  // Popped pane stays ACTIVE so its config/controls persist (regression: gear cleared on pop-out).
  const popOk = poppedInfo?.popped === true && poppedInfo?.active === true;
  console.log(`SELFTEST pop-out: ${pane2.id} popped=${poppedInfo?.popped} stillActive=${poppedInfo?.active}`);

  // 6c) closing the pop-out window re-docks the pane (doesn't destroy it).
  manager.__closePoppedWindow(pane2.id);
  await new Promise((r) => setTimeout(r, 200));
  const afterDock = JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
    panes: { id: string; popped?: boolean }[];
  };
  const dockedPane = afterDock.panes.find((p) => p.id === pane2.id);
  const redockOk = !!dockedPane && dockedPane.popped !== true; // still exists, no longer popped
  console.log(`SELFTEST re-dock: pane present=${!!dockedPane} popped=${dockedPane?.popped ?? false} ok=${redockOk}`);

  // 7) repro builder: run via the React test hook, confirm inline render + session persistence
  const builder = (await tl.executeJavaScript(`(async () => {
    await window.__devloopTest.runRepro([{ kind: 'navigate', url: 'data:text/html,<title>x</title>' }]);
    await new Promise(r=>setTimeout(r,1500));
    const listText = document.getElementById('list').textContent || '';
    const sess = await window.devloop.session();
    return JSON.stringify({ inlineRendered: listText.includes('▶ repro'), sessionSteps: (sess.steps||[]).length });
  })()`)) as string;
  console.log(`SELFTEST repro builder -> ${builder}`);
  const b = JSON.parse(builder);
  const builderOk = b.inlineRendered === true && b.sessionSteps >= 1;

  // 8) dev server via the UI path (sets awaitingDevUrl): a server that prints a localhost URL
  //    must trigger auto-navigate, and the sleep 6017 group must die on quit.
  const devArgs = JSON.stringify({
    cmd: 'bash -c "echo Local: http://localhost:4599; sleep 6017"',
    cwd: process.cwd(),
  });
  await tl.executeJavaScript(`window.devloop.devStart(${devArgs})`);
  await new Promise((r) => setTimeout(r, 1000));
  const devName = JSON.parse((await handleTool("dev_status")).content[0]!.text as string).name;
  console.log(`SELFTEST dev started via UI (auto-nav to :4599); project name=${devName}`);
  const nameOk = devName === "devloop-mcp"; // package.json name of this repo

  // 8b) per-pane: the dev server's logs are tagged with the active pane; reload IPC works.
  const activeId = (JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as { panes: { id: string; active: boolean }[] }).panes.find((p) => p.active)!.id;
  const serverTagged = buffer.query({ source: "server" }).some((e) => e.target === activeId);
  await tl.executeJavaScript("window.devloop.reload(false)");
  await tl.executeJavaScript("window.devloop.reload(true)");
  console.log(`SELFTEST per-pane: activePane=${activeId} serverLogTagged=${serverTagged}`);
  const perPaneOk = serverTagged;

  // 8c) app-scoped logs: get_logs({ app }) returns only that pane's entries.
  const scoped = JSON.parse((await handleTool("get_logs", { app: activeId, limit: 500 })).content[0]!.text as string) as {
    entries: { target?: string }[];
  };
  const appScopeOk = scoped.entries.length > 0 && scoped.entries.every((e) => e.target === activeId);
  console.log(`SELFTEST app-scope: app=${activeId} entries=${scoped.entries.length} allTagged=${appScopeOk}`);

  // 8d) browser_snapshot + browser_wait_for (+ a repro 'wait' step).
  await manager.navigate("data:text/html,<h1>snap</h1><label for=q>Find</label><input id=q><button id=b aria-label='Tap'>x</button>");
  const waitRes = JSON.parse((await handleTool("browser_wait_for", { selector: "#b", timeoutMs: 3000 })).content[0]!.text as string) as { ok: boolean };
  const snap = JSON.parse((await handleTool("browser_snapshot")).content[0]!.text as string) as { nodes: { ref: string; role: string; name: string }[] };
  const hasBtn = snap.nodes.some((n) => n.ref === "#b" && n.role === "button" && n.name === "Tap");
  const hasInput = snap.nodes.some((n) => n.ref === "#q" && n.role === "textbox" && n.name === "Find");
  const reproWait = JSON.parse((await handleTool("repro", { action: { kind: "wait", selector: "#b", timeoutMs: 3000 }, waitFor: "settle", settleMs: 200 })).content[0]!.text as string) as { stepCount: number };
  const snapshotOk = waitRes.ok && hasBtn && hasInput && reproWait.stepCount === 1;
  console.log(`SELFTEST snapshot: nodes=${snap.nodes.length} waitOk=${waitRes.ok} btn=${hasBtn} input=${hasInput} reproWait=${reproWait.stepCount} ok=${snapshotOk}`);

  // 8e) richer interactions: select / press / hover.
  await manager.navigate(
    `data:text/html,<select id=s><option value=a>A</option><option value=b>B</option></select><input id=t onkeydown="if(event.key==='Enter')window.__p=1"><button id=h onmouseover="window.__h=1">h</button>`,
  );
  await handleTool("browser_select", { selector: "#s", value: "b" });
  await handleTool("browser_press", { key: "Enter", selector: "#t" });
  await handleTool("browser_hover", { selector: "#h" });
  const ixv = JSON.parse(
    JSON.parse((await handleTool("browser_eval", { expression: "JSON.stringify({sel:document.getElementById('s').value,p:!!window.__p,h:!!window.__h})" })).content[0]!.text as string).value as string,
  ) as { sel: string; p: boolean; h: boolean };
  const ixOk = ixv.sel === "b" && ixv.p && ixv.h;
  console.log(`SELFTEST interactions: select=${ixv.sel === "b"} press=${ixv.p} hover=${ixv.h} ok=${ixOk}`);

  // 8f) element picker: pick() resolves the selector of the element the user clicks.
  await manager.navigate("data:text/html,<button id=pk>pick me</button>");
  const pickPromise = manager.pick();
  await new Promise((r) => setTimeout(r, 300)); // let the picker install its listeners
  await manager.click("#pk"); // a real click resolves the picker
  const picked = await pickPromise;
  const pickOk = picked === "#pk";
  console.log(`SELFTEST picker: picked=${picked} ok=${pickOk}`);

  // 9) network body: fetch the cockpit's own HTTP server for a 404 (subresource → reliable body).
  await manager.navigate(
    `data:text/html,<script>fetch('http://localhost:${chosenPort}/nope').catch(()=>{})</script>`,
  );
  await new Promise((r) => setTimeout(r, 800));
  const net = buffer
    .query({ source: "browser", stream: "network" })
    .find((e) => (e.detail as { status?: number })?.status === 404);
  const body = (net?.detail as { responseBody?: string } | undefined)?.responseBody;
  const bodyOk = typeof body === "string" && body.includes("not found");
  console.log(`SELFTEST network body: status=${(net?.detail as { status?: number })?.status} body=${JSON.stringify(body)}`);

  // 9b) enriched network detail + HAR export.
  const nd = net?.detail as { requestHeaders?: unknown; responseHeaders?: unknown; durationMs?: number } | undefined;
  const har = JSON.parse((await handleTool("export_har", {})).content[0]!.text as string) as { log: { entries: { response?: { status?: number } }[] } };
  const harHas404 = har.log.entries.some((en) => en.response?.status === 404);
  const harOk = !!nd?.requestHeaders && !!nd?.responseHeaders && har.log.entries.length >= 1 && harHas404;
  console.log(`SELFTEST HAR: entries=${har.log.entries.length} 404=${harHas404} reqH=${!!nd?.requestHeaders} resH=${!!nd?.responseHeaders} ok=${harOk}`);

  // 9c) clear storage: set localStorage on a real http origin, clear, verify it's gone.
  await manager.navigate(`http://localhost:${chosenPort}/devloop-clear-test`);
  await new Promise((r) => setTimeout(r, 300));
  await handleTool("browser_eval", { expression: "localStorage.setItem('__cs','yes')" });
  const csBefore = JSON.parse((await handleTool("browser_eval", { expression: "localStorage.getItem('__cs')" })).content[0]!.text as string).value as string | null;
  await handleTool("browser_clear_storage", {});
  const csAfter = JSON.parse((await handleTool("browser_eval", { expression: "localStorage.getItem('__cs')" })).content[0]!.text as string).value as string | null;
  const clearOk = csBefore === "yes" && csAfter === null;
  console.log(`SELFTEST clear-storage: before=${csBefore} after=${csAfter} ok=${clearOk}`);

  // 9d) device emulation + network throttling.
  await manager.navigate('data:text/html,<meta name="viewport" content="width=device-width"><h1>vp</h1>');
  await handleTool("browser_emulate", { device: "iphone" });
  const ew = JSON.parse((await handleTool("browser_eval", { expression: "String(innerWidth)" })).content[0]!.text as string).value as string;
  await handleTool("browser_emulate", { reset: true });
  const ew2 = JSON.parse((await handleTool("browser_eval", { expression: "String(innerWidth)" })).content[0]!.text as string).value as string;
  const emuOk = ew === "390" && Number(ew2) > 390;
  await handleTool("browser_throttle", { profile: "offline" });
  const thOff = JSON.parse((await handleTool("browser_eval", { expression: `fetch('http://localhost:${chosenPort}/x').then(()=>'ok').catch(()=>'fail')` })).content[0]!.text as string).value as string;
  await handleTool("browser_throttle", { profile: "none" });
  const thOn = JSON.parse((await handleTool("browser_eval", { expression: `fetch('http://localhost:${chosenPort}/x').then(()=>'ok').catch(()=>'fail')` })).content[0]!.text as string).value as string;
  const emulateOk = emuOk && thOff === "fail" && thOn === "ok";
  console.log(`SELFTEST emulate/throttle: vp=${ew}→${ew2} offline=${thOff} none=${thOn} ok=${emulateOk}`);

  // 9e) diagnose: group duplicate errors + collect network failures.
  await handleTool("clear_logs", {});
  await manager.navigate(`data:text/html,<script>console.error('[boom] beta');console.error('[boom] beta');fetch('http://localhost:${chosenPort}/nope').catch(()=>{})</script>`);
  await new Promise((r) => setTimeout(r, 700));
  const diag = JSON.parse((await handleTool("diagnose", {})).content[0]!.text as string) as {
    errorCount: number;
    groups: { count: number }[];
    network: { status?: number }[];
  };
  const diagnoseOk = diag.errorCount >= 2 && diag.groups.some((g) => g.count >= 2) && diag.network.some((n) => n.status === 404);
  console.log(`SELFTEST diagnose: errors=${diag.errorCount} dupGroup=${diag.groups.some((g) => g.count >= 2)} net404=${diag.network.some((n) => n.status === 404)} ok=${diagnoseOk}`);

  // 9f) export_bundle: capture a screenshot, then assemble the bundle (logs + screenshot + har + diagnose).
  await tl.executeJavaScript("window.devloop.screenshot()");
  await new Promise((r) => setTimeout(r, 400));
  const bundle = JSON.parse((await handleTool("export_bundle", {})).content[0]!.text as string) as {
    meta: { counts: { logs: number; errors: number; screenshots: number } };
    diagnose: unknown;
    har: unknown;
    screenshots: unknown[];
    logs: unknown[];
  };
  const bundleOk = !!bundle.diagnose && !!bundle.har && bundle.screenshots.length >= 1 && bundle.logs.length > 0 && bundle.meta.counts.errors >= 2;
  console.log(`SELFTEST bundle: logs=${bundle.meta.counts.logs} screenshots=${bundle.screenshots.length} errors=${bundle.meta.counts.errors} ok=${bundleOk}`);

  // 9g) chrome extension: load the unpacked fixture into the panes' session; its content script marks pages.
  let extLoadedOk = false;
  const extPath = [join(BASE, "../test/fixture-ext"), join(BASE, "test/fixture-ext")].find(existsSync);
  try {
    const loaded = await extSession().extensions.loadExtension(extPath!, { allowFileAccess: true });
    const listed = extSession().extensions.getAllExtensions().some((x) => x.id === loaded.id && x.name === "devloop-test-ext");
    await manager.navigate(`http://localhost:${chosenPort}/ext-check`);
    await new Promise((r) => setTimeout(r, 700));
    const marked = JSON.parse((await handleTool("browser_eval", { expression: "String(document.documentElement.getAttribute('data-devloop-ext'))" })).content[0]!.text as string).value as string;
    extLoadedOk = listed && marked === "loaded";
    console.log(`SELFTEST extension: listed=${listed} contentScriptRan=${marked === "loaded"} ok=${extLoadedOk}`);
  } catch (e) {
    console.log(`SELFTEST extension FAILED (path=${extPath}): ${e}`);
  }

  // 10) self-heal: crash the active pane's renderer, then confirm it recovers (navigates again).
  manager.__crashActive();
  await new Promise((r) => setTimeout(r, 1500));
  await manager.navigate("data:text/html,<script>console.log('post-crash-ok')</script>");
  await new Promise((r) => setTimeout(r, 400));
  const recovered = buffer.query({}).some((e) => e.line.includes("post-crash-ok"));
  console.log(`SELFTEST self-heal: recovered=${recovered}`);

  // 11) regression: closing every pane then a dev action must not crash ("no pane undefined").
  let robustOk = false;
  try {
    for (const p of (JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as { panes: { id: string }[] }).panes) {
      await handleTool("pane_close", { id: p.id });
    }
    await new Promise((r) => setTimeout(r, 300)); // let the replacement pane settle
    JSON.parse((await handleTool("dev_status")).content[0]!.text as string); // must not throw
    await tl.executeJavaScript(`window.devloop.setDevConfig({ cwd: ${JSON.stringify(process.cwd())} })`);
    const after = (JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as { panes: unknown[] }).panes.length;
    robustOk = after >= 1;
    console.log(`SELFTEST robustness (close-all → dev action): panesAfter=${after} ok=${robustOk}`);
  } catch (e) {
    console.log(`SELFTEST robustness FAILED: ${e}`);
  }

  // 12) dev "failed" state: a non-zero exit surfaces as exitCode on the status.
  await tl.executeJavaScript(`window.devloop.devStart({ cmd: "bash -c 'exit 3'", cwd: ${JSON.stringify(process.cwd())} })`);
  await new Promise((r) => setTimeout(r, 800));
  const failStatus = JSON.parse((await handleTool("dev_status")).content[0]!.text as string) as { exitCode?: number };
  const failOk = failStatus.exitCode === 3;
  console.log(`SELFTEST dev failed: exitCode=${failStatus.exitCode} ok=${failOk}`);

  // 13) screenshot → a 'screenshot' timeline entry carrying a PNG data URL.
  await tl.executeJavaScript("window.devloop.screenshot()");
  await new Promise((r) => setTimeout(r, 500));
  const shotEntry = buffer.query({ source: "browser", stream: "screenshot" }).pop();
  const shotImg = (shotEntry?.detail as { image?: string } | undefined)?.image;
  const shotOk = typeof shotImg === "string" && shotImg.startsWith("data:image/png");
  console.log(`SELFTEST screenshot: present=${!!shotEntry} ok=${shotOk}`);

  const checks: [string, boolean][] = [
    ["renderer api present", api === "object"],
    ["mcp-over-http repro", mcpReproOk],
    ["renderer→buffer flow", got],
    ["in-process tool call", inTool],
    ["registry visible to renderer", rendererSees.includes("selftest-proj")],
    ["multiple panes", paneList.panes.length >= 2],
    ["per-pane event tagging", taggedRight],
    ["pop-out", popOk],
    ["re-dock", redockOk],
    ["repro builder inline render", builderOk],
    ["derived project name", nameOk],
    ["pane persistence", persistOk],
    ["per-pane dev server-log tagging", perPaneOk],
    ["network response body", bodyOk],
    ["self-heal after renderer crash", recovered],
    ["robustness (close-all → dev action)", robustOk],
    ["dev failed-state exit code", failOk],
    ["screenshot → timeline", shotOk],
    ["app-scoped get_logs", appScopeOk],
    ["browser_snapshot + wait_for", snapshotOk],
    ["interactions (select/press/hover)", ixOk],
    ["element picker", pickOk],
    ["HAR export", harOk],
    ["clear storage", clearOk],
    ["device emulation + throttle", emulateOk],
    ["diagnose (group + network)", diagnoseOk],
    ["export bundle", bundleOk],
    ["chrome extension (unpacked)", extLoadedOk],
  ];
  for (const [name, c] of checks) console.log(`  ${c ? "✓" : "✗"} ${name}`);
  const failed = checks.filter(([, c]) => !c).map(([n]) => n);
  if (failed.length) {
    console.log(`SELFTEST FAIL (${failed.length}): ${failed.join(", ")}`);
    app.exit(1); // non-zero so CI gates on it
    return;
  }
  console.log("SELFTEST OK");
  // Exit via the real user path — close the control window with panes still open.
  // This exercises pane-close → onChange teardown (regression: "Object has been destroyed").
  shellWin!.close();
}

/** Kill everything we started: dev-server process group, browser panes, HTTP server. */
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  if (manager) manager.onChange = undefined; // stop notifying a window that's tearing down
  try {
    observability.detachAll(); // stop RN controllers + native log streams
    serveSim.stop(); // stop the serve-sim process
  } catch (e) {
    log(`cleanup observability: ${e}`);
  }
  try {
    void manager?.close(); // stops every pane's dev server + closes panes/popped windows
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

/** Request a graceful quit, then hard-exit if it stalls (orphaned view webContents, GPU proc, etc.). */
function quitHard(): void {
  cleanup();
  app.quit();
  setTimeout(() => app.exit(0), 1200);
}

app.on("before-quit", cleanup);
app.on("window-all-closed", quitHard);
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
