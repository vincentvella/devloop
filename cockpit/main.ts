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

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, nativeImage, shell } from "electron";

// Where main.cjs/preload.cjs/renderer live. Bun inlines __dirname to the SOURCE dir,
// so we can't use it. Packaged: <app.asar>/out via getAppPath(). Dev (`electron
// out/main.cjs`): the dir of the script Electron actually ran.
const BASE = app.isPackaged ? join(app.getAppPath(), "out") : dirname(resolve(process.argv[1] ?? "."));

import { buildIssueUrl, errorText } from "../src/crashReport.ts";
import type { DevServerLike } from "../src/devServer.ts";
import { startHttpMcp } from "../src/httpMcp.ts";
import { LogBuffer } from "../src/logBuffer.ts";
import { buildMcpServer } from "../src/mcpServer.ts";
import type { Platform } from "../src/nativeBuild.ts";
import { nativeEnvReady, nativeEnvSummary } from "../src/nativeEnv.ts";
import { addProject, getPanes, getProject, getSession, listProjects, setSession } from "../src/registry.ts";
import { mergePath, parseShellPath } from "../src/shellPath.ts";
import { configureTools, handleTool } from "../src/toolLayer.ts";
import { BrowserManager } from "./browserManager.ts";
import { createExtensionManager } from "./extensions.ts";
import { registerIpc } from "./ipc.ts";
import { NativeObservability } from "./nativeObservability.ts";
import { createNativeTargets } from "./nativeTargets.ts";
import { runSelfTest } from "./selftest/index.ts";
import { ServeSim } from "./serveSim.ts";
import { initAutoUpdate, type Updater } from "./updater.ts";

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
    const out = execFileSync(shell, ["-lic", `printf '%s' '${marker}'; printf '%s' "$PATH"`], {
      encoding: "utf8",
      timeout: 4000,
    });
    const got = parseShellPath(out, marker);
    if (got) {
      process.env.PATH = mergePath(process.env.PATH, got);
      log(`imported login-shell PATH (${got.split(":").length} entries)`);
    }
  } catch (e) {
    log(`shell PATH import failed: ${(e as Error).message}`);
  }
}

let httpServer: { close(): void } | undefined;
let cleanedUp = false;

// --- MCP over HTTP (stateful sessions) — shared transport with the daemon (#22) ---
async function startHttp(): Promise<void> {
  const { server, port } = await startHttpMcp({
    buildServer: () => buildMcpServer("devloop-cockpit"),
    port: PORT,
    log,
  });
  httpServer = server;
  chosenPort = port;
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
  shellWin.webContents.on("render-process-gone", (_e, details) => {
    // A clean teardown on quit reports reason "clean-exit" — don't nag about that.
    if (details.reason === "clean-exit") return log(`renderer exited cleanly`);
    reportCrash("timeline renderer", `renderer gone: ${details.reason} (exitCode=${details.exitCode})`);
  });
  app.on("child-process-gone", (_e, details) => {
    const who = `${details.type}/${details.name ?? ""}`.replace(/\/$/, "");
    if (details.reason === "clean-exit") return log(`child process ${who} exited cleanly`);
    reportCrash(`${who} process`, `child process gone: ${who} ${details.reason} (exitCode=${details.exitCode})`);
  });
  // The timeline is the control surface — closing it tears the whole app down.
  shellWin.on("closed", () => quitHard());
  void shellWin.loadFile(join(BASE, "renderer/index.html"));

  // Stream live events to the timeline window.
  buffer.onPush((e) => shellWin?.webContents.send("devloop:push", e));
}

const WELCOME =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<html><body style="margin:0;font:14px ui-monospace,monospace;background:#0d1117;color:#8b949e;display:grid;place-items:center;height:100vh"><div style="text-align:center"><div style="font-size:18px;color:#c9d1d9">Devloop — app pane</div><div style="margin-top:8px">Enter a URL in the timeline window's bar, or dev_start a project.</div></div></body></html>`,
  );

function log(msg: string): void {
  process.stderr.write(`[cockpit] ${msg}\n`);
}

// --- boot ------------------------------------------------------------------
async function main() {
  // Key the state dir on environment so a dev build or the selftest never mutates the
  // installed app's real ~/.devloop. Respect an explicit DEVLOOP_HOME (gui harness /
  // power users); packaged prod falls through to the ~/.devloop default.
  if (!process.env.DEVLOOP_HOME) {
    if (SELFTEST) process.env.DEVLOOP_HOME = mkdtempSync(join(tmpdir(), "devloop-selftest-home-"));
    else if (!app.isPackaged) process.env.DEVLOOP_HOME = join(homedir(), ".devloop-dev");
  }
  log(`state: DEVLOOP_HOME=${process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop")}`);

  if (SELFTEST) {
    app.dock?.hide();
    // Hermetic profile: an isolated Chromium userData dir so the headless run never
    // contends with a real Devloop.app instance's storage/quota DB (that contention
    // deadlocked the clear-storage step). Must be set before app.whenReady().
    app.setPath("userData", mkdtempSync(join(tmpdir(), "devloop-selftest-ud-")));
    // Backstop only — the suite's real protection is the per-step ratchet in runSelfTest
    // (tick()), which attributes a hang to a named step. This generous timer just keeps a
    // totally-wedged process (e.g. a boot hang before the ratchet starts) from hanging CI.
    setTimeout(() => {
      log("SELFTEST backstop: process wedged, exiting");
      app.exit(2);
    }, 300_000);
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

  // Subsystem handles. `shellWin` exists (createWindows, above). We create the pane
  // manager NOW — synchronously, before registerIpc and before the first `await` — so
  // the renderer's mount-time IPC (panes/setBounds/overlay) always finds it ready
  // instead of racing an undefined `manager`. getManager()/getShellWin() stay lazy so
  // all the wiring reads uniformly.
  const exts = createExtensionManager({ BASE, log, getShellWin: () => shellWin });
  const native = createNativeTargets({
    getManager: () => manager,
    getShellWin: () => shellWin,
    serveSim,
    observability,
    buffer,
    log,
  });

  // Created up-front (see above); it does not navigate until start() below, which
  // stays after initExtensions so extensions load before the first pane navigates.
  manager = new BrowserManager(
    buffer,
    {
      networkErrorThreshold: Number(process.env.DEVLOOP_NET_THRESHOLD ?? 400),
      actionTimeoutMs: Number(process.env.DEVLOOP_ACTION_TIMEOUT ?? 10_000),
    },
    SELFTEST,
    {
      indexPath: join(BASE, "renderer/index.html"),
      preloadPath: join(BASE, "preload.cjs"),
      simPreloadPath: join(BASE, "simPreload.cjs"),
    },
    exts.prepareSession, // #27: load extensions into each per-project session before its pane navigates
  );
  manager.attachTo(shellWin!);
  manager.onChange = () => {
    if (shellWin && !shellWin.isDestroyed()) shellWin.webContents.send("devloop:panesChanged");
  };
  // Swap panes while a sim/mirror is up → foreground that pane's app on the device.
  manager.onActivePaneChanged = (pane, target) => void native.foregroundApp(pane.dev?.cwd, target);

  registerIpc({
    buffer,
    getManager: () => manager,
    getShellWin: () => shellWin,
    log,
    getUpdater: () => updater,
    exts,
    native,
    listProjects,
    addProject,
    getProject,
    getSession,
    setSession,
  });
  // Auto-update: check GitHub on launch (packaged + signed builds only) and prompt.
  updater = initAutoUpdate({ win: shellWin, log, enabled: app.isPackaged && !SELFTEST });
  void updater.check();
  await exts.initExtensions(); // load extensions into the panes' session before panes navigate
  log("starting browser manager (first pane)");
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
    start: (cmd, cwd, label) => manager.devStart(undefined, cmd, cwd, label),
    stop: () => manager.devStop(),
    status: () => manager.devStatus(),
  };
  configureTools({
    buffer,
    browser: manager,
    devServer: devFacade,
    nativeEnv: () => {
      const p = native.probeNativeEnv();
      return { ready: nativeEnvReady(p), summary: nativeEnvSummary(p) };
    },
    // native_open / native_close / native_build over MCP — same path as the cockpit buttons.
    nativeControl: {
      open: (platform) => (platform === "android" ? native.doOpenAndroid() : native.doOpenSimulator()),
      close: async () => {
        await native.doCloseSimulator();
        await native.doCloseAndroid();
      },
      build: async (platform, cwd) => native.doNativeBuild(platform as Platform, cwd),
      doctor: async () => native.doctor(),
    },
    // ext_* over MCP — same path as the cockpit's Settings "ext" row.
    extControl: {
      list: () => exts.extList(),
      install: (input) => exts.doExtInstall(input),
      remove: (id) => exts.doExtRemove(id),
      setEnabled: (id, enabled) => exts.doExtSetEnabled(id, enabled),
    },
  });

  await startHttp();
  log("ready");

  if (SELFTEST) {
    await runSelfTest({
      app,
      log,
      manager,
      buffer,
      handleTool,
      shellWin: shellWin!,
      chosenPort,
      getPanes,
      BASE,
      extSession: exts.extSession,
      loadExtIntoAll: exts.loadExtIntoAll,
    });
  } else if (manager.currentUrl() === "about:blank") {
    await manager.navigate(WELCOME); // only on a fresh pane — restored panes keep their URL
  }
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

// Crash → GitHub issue. No telemetry vendor: on a crash we offer to open a prefilled
// issue (the user reviews + submits it, so nothing leaves the machine silently).
// Debounced so a crash storm doesn't stack dialogs; quiet outside packaged builds
// (dev/selftest just log the URL so CI never blocks on a modal).
let crashPrompting = false;
function reportCrash(kind: string, error: unknown): void {
  log(`CRASH (${kind}): ${errorText(error)}`);
  const url = buildIssueUrl({
    kind,
    error,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
  });
  if (!app.isPackaged || SELFTEST) {
    log(`report this crash → ${url}`);
    return;
  }
  if (crashPrompting) return;
  crashPrompting = true;
  void dialog
    .showMessageBox(shellWin && !shellWin.isDestroyed() ? shellWin : (undefined as never), {
      type: "error",
      title: "Devloop crashed",
      message: `Devloop's ${kind} hit an unexpected error.`,
      detail:
        "You can open a prefilled GitHub issue — review it (remove anything sensitive) and submit under your own account. Nothing is sent automatically.",
      buttons: ["Report on GitHub…", "Ignore"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then((r) => {
      if (r.response === 0) void shell.openExternal(url);
    })
    .catch((e) => log(`crash dialog failed: ${e}`))
    .finally(() => {
      crashPrompting = false;
    });
}

process.on("uncaughtException", (e) => reportCrash("main process", e));
process.on("unhandledRejection", (e) => reportCrash("main process (promise)", e));
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
