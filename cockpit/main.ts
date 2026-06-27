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

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell } from "electron";
import {
  installChromeWebStore,
  installExtension,
  loadAllExtensions,
  uninstallExtension,
} from "electron-chrome-web-store";
import { type ExtMeta, extensionIdFromInput, unifyExtensions } from "../src/extensions.ts";
import { DEFAULT_PARTITION } from "../src/partition.ts";
import {
  getDisabledExtensions,
  getUnpackedExtensions,
  setDisabledExtensions,
  setUnpackedExtensions,
} from "../src/registry.ts";
import { mergePath, parseShellPath } from "../src/shellPath.ts";

// Where main.cjs/preload.cjs/renderer live. Bun inlines __dirname to the SOURCE dir,
// so we can't use it. Packaged: <app.asar>/out via getAppPath(). Dev (`electron
// out/main.cjs`): the dir of the script Electron actually ran.
const BASE = app.isPackaged ? join(app.getAppPath(), "out") : dirname(resolve(process.argv[1] ?? "."));

import { adbKeyeventArgs, adbTapArgs, adbTextArgs, androidKeycodeFor, usableSerials } from "../src/adb.ts";
import { adbBinary } from "../src/androidLog.ts";
import { AndroidScreenStream, deviceSize } from "../src/androidMirror.ts";
import { bundleToHtml } from "../src/bundle.ts";
import { blankIssueUrl, buildIssueUrl, errorText } from "../src/crashReport.ts";
import { type DevServerLike, projectName } from "../src/devServer.ts";
import { startHttpMcp } from "../src/httpMcp.ts";
import { LogBuffer } from "../src/logBuffer.ts";
import { buildMcpServer } from "../src/mcpServer.ts";
import { type Platform, resolveNativeInfo } from "../src/nativeBuild.ts";
import { computeFingerprint, runNativeBuild } from "../src/nativeBuildRunner.ts";
import {
  type AndroidEnvProbe,
  androidEnvChecks,
  androidEnvIssues,
  androidEnvReady,
  androidEnvSummary,
  type NativeEnvProbe,
  nativeEnvChecks,
  nativeEnvIssues,
  nativeEnvReady,
  nativeEnvSummary,
} from "../src/nativeEnv.ts";
import { deriveAppMatch, metroBaseFromUrl } from "../src/nativeObservability.ts";
import {
  addProject,
  getPanes,
  getProject,
  getProjectFingerprint,
  getSession,
  listProjects,
  setSession,
} from "../src/registry.ts";
import { detectTargetKind } from "../src/target.ts";
import { configureTools, handleTool } from "../src/toolLayer.ts";
import { BrowserManager } from "./browserManager.ts";
import { NativeObservability } from "./nativeObservability.ts";
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

/** Probe native-interaction readiness (idb CLI + companion + a booted sim). */
function probeNativeEnv(): NativeEnvProbe {
  const has = (cmd: string): boolean => {
    try {
      execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  let bootedSim = false;
  try {
    bootedSim = /Booted/.test(
      execFileSync("xcrun", ["simctl", "list", "devices", "booted"], { encoding: "utf8", timeout: 5000 }),
    );
  } catch {
    /* no xcrun / Xcode */
  }
  return { idb: has("idb"), idbCompanion: has("idb_companion"), bootedSim };
}

/** Run `adb <args>` → stdout (async). adb is resolved via the SDK if not on PATH. */
function runAdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adbBinary(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || (err as Error).message)) : resolve(stdout),
    );
  });
}

/** Probe Android-interaction readiness: adb present + at least one usable device. */
function probeAndroidEnv(): AndroidEnvProbe {
  let adbOk = false;
  let serials: string[] = [];
  try {
    const out = execFileSync(adbBinary(), ["devices"], { encoding: "utf8", timeout: 5000 });
    adbOk = true;
    serials = usableSerials(out);
  } catch {
    /* no adb / SDK */
  }
  return { adb: adbOk, bootedDevice: serials.length > 0 };
}

/** First usable Android serial, or null. */
function firstAndroidSerial(): string | null {
  try {
    return usableSerials(execFileSync(adbBinary(), ["devices"], { encoding: "utf8", timeout: 5000 }))[0] ?? null;
  } catch {
    return null;
  }
}

let androidStream: AndroidScreenStream | undefined;

// --- native target control (shared by the renderer IPCs + the native_* MCP tools) ---

async function doOpenSimulator(): Promise<{ ok: boolean; summary?: string }> {
  const info = await serveSim.ensure(); // serve-sim captures the booted iOS sim as an interactive MJPEG preview
  if (!info) {
    log("simulator: serve-sim has no booted device (boot a simulator first)");
    return { ok: false, summary: "no booted iOS simulator (boot one in Simulator.app)" };
  }
  await manager.setSimulatorActive(true, info);
  const active = manager.listPanes().find((p) => p.active);
  // Preflight: native taps/snapshot need idb + companion + a booted sim — surface gaps on the timeline.
  const issues = nativeEnvIssues(probeNativeEnv());
  if (issues.length) {
    log(`native env: ${nativeEnvSummary(probeNativeEnv())}`);
    buffer.push(
      "native",
      "log",
      `⚠ native interactions unavailable — ${issues.map((i) => `${i.what} → ${i.fix}`).join("; ")}`,
      undefined,
      active?.id,
    );
  }
  const metroBase = metroBaseFromUrl(active?.url);
  if (active && metroBase) {
    const rn = observability.attach({
      paneId: active.id,
      metroBase,
      device: "booted",
      appMatch: active.dev?.cwd ? appMatchFor(active.dev.cwd) : undefined,
    });
    manager.setNativeController(active.id, rn); // browser_* → the RN/idb controller while iOS is active
  } else {
    log("simulator: no Metro URL on the active pane — start its bundler to stream JS logs");
  }
  return { ok: true };
}

async function doCloseSimulator(): Promise<void> {
  await manager.setSimulatorActive(false); // browser_* route back to the web pane
  observability.detachAll();
  const active = manager.listPanes().find((p) => p.active);
  if (active) manager.setNativeController(active.id, undefined);
}

async function doOpenAndroid(): Promise<{ ok: boolean; summary?: string; serial?: string }> {
  const probe = probeAndroidEnv();
  const issues = androidEnvIssues(probe);
  const active = manager.listPanes().find((p) => p.active);
  if (issues.length) {
    log(`android env: ${androidEnvSummary(probe)}`);
    buffer.push(
      "native",
      "log",
      `⚠ Android interactions unavailable — ${issues.map((i) => `${i.what} → ${i.fix}`).join("; ")}`,
      undefined,
      active?.id,
    );
    if (!probe.adb || !probe.bootedDevice) return { ok: false, summary: androidEnvSummary(probe) };
  }
  const serial = firstAndroidSerial();
  if (!serial) return { ok: false, summary: "no usable Android device" };
  const metroBase = metroBaseFromUrl(active?.url);
  if (active) {
    // With Metro → JS over CDP too; without → still mirror + allow taps.
    const rn = observability.attach({
      paneId: active.id,
      metroBase: metroBase || "http://localhost:8081",
      device: serial,
      platform: "android",
    });
    manager.setNativeController(active.id, rn);
  }
  manager.setAndroidActive(true);
  const size = await deviceSize(serial).catch(() => null);
  shellWin?.webContents.send("devloop:androidSize", size ?? { width: 1080, height: 2400 });
  androidStream?.stop();
  if (!process.env.DEVLOOP_NO_ANDROID_STREAM) {
    androidStream = new AndroidScreenStream({
      serial,
      onFrame: (b64) => shellWin?.webContents.send("devloop:androidFrame", b64),
    });
    androidStream.start();
  }
  log(`android: mirroring ${serial}${metroBase ? ` (JS=${metroBase})` : ""}`);
  return { ok: true, serial };
}

async function doCloseAndroid(): Promise<void> {
  androidStream?.stop();
  androidStream = undefined;
  manager.setAndroidActive(false);
  observability.detachAll();
  const active = manager.listPanes().find((p) => p.active);
  if (active) manager.setNativeController(active.id, undefined);
}

function doNativeBuild(platform: Platform, cwd?: string, eas?: boolean): { started: boolean; detail?: string } {
  const active = manager.listPanes().find((p) => p.active);
  const root = cwd || active?.dev?.cwd;
  if (!root || !platform) return { started: false, detail: "no project cwd — set the pane's project or pass cwd" };
  const mode = eas ? "eas" : "local";
  // streams to the timeline; a local build records a fingerprint on success, an EAS cloud build doesn't.
  runNativeBuild({ buffer, projectRoot: root, platform, mode });
  return { started: true, detail: `building ${platform} ${eas ? "in the EAS cloud" : `in ${root}`}` };
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

// --- IPC for the timeline renderer ----------------------------------------
function wireIpc(): void {
  ipcMain.handle("devloop:getLogs", (_e, opts) => buffer.query(opts ?? {}));
  ipcMain.handle("devloop:clear", () => {
    buffer.clear();
    return true;
  });
  ipcMain.handle("devloop:navigate", (_e, url: string) => manager.navigate(url));
  ipcMain.handle("devloop:nativeElements", async () => {
    // The native (idb) a11y snapshot for the iOS picker — routed to the RN controller
    // while the simulator target is active. Returns [] off-native or on error.
    try {
      return (await manager.snapshot()).nodes;
    } catch {
      return [];
    }
  });
  ipcMain.handle("devloop:nativeEnv", () => {
    const probe = probeNativeEnv();
    return { ready: nativeEnvReady(probe), checks: nativeEnvChecks(probe) };
  });
  ipcMain.handle("devloop:checkForUpdates", () => updater?.check(true));
  ipcMain.handle("devloop:updateDownload", () => updater?.download());
  ipcMain.handle("devloop:updateInstall", () => updater?.install());
  ipcMain.handle("devloop:openExtensions", () => openExtensionsWindow());
  ipcMain.handle("devloop:reportBug", () =>
    shell.openExternal(
      blankIssueUrl({
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron,
      }),
    ),
  );
  ipcMain.handle("devloop:nativeInfo", (_e, cwd: string) => nativeInfo(cwd));
  ipcMain.handle("devloop:nativeBuild", (_e, cwd: string, platform: Platform) => doNativeBuild(platform, cwd));
  // Simulator: serve-sim's interactive MJPEG preview in a pane view (see doOpenSimulator).
  ipcMain.handle("devloop:openSimulator", () => doOpenSimulator());
  ipcMain.handle("devloop:closeSimulator", async () => {
    await doCloseSimulator();
    return { ok: true };
  });

  // --- Android: drive an emulator/device + mirror its screen into the pane ---
  ipcMain.handle("devloop:androidEnv", () => {
    const probe = probeAndroidEnv();
    return { ready: androidEnvReady(probe), checks: androidEnvChecks(probe), summary: androidEnvSummary(probe) };
  });
  ipcMain.handle("devloop:openAndroid", () => doOpenAndroid());
  ipcMain.handle("devloop:closeAndroid", async () => {
    await doCloseAndroid();
    return { ok: true };
  });
  // Input from the mirror's click/key layer → adb. Coordinates arrive in device px.
  ipcMain.handle("devloop:androidTap", async (_e, x: number, y: number) => {
    const serial = firstAndroidSerial();
    if (serial) await runAdb(adbTapArgs(serial, x, y)).catch((e) => log(`android tap failed: ${(e as Error).message}`));
  });
  ipcMain.handle("devloop:androidText", async (_e, text: string) => {
    const serial = firstAndroidSerial();
    if (serial && text)
      await runAdb(adbTextArgs(serial, text)).catch((e) => log(`android text failed: ${(e as Error).message}`));
  });
  ipcMain.handle("devloop:androidKey", async (_e, key: string) => {
    const serial = firstAndroidSerial();
    const code = androidKeycodeFor(key);
    if (serial && code != null)
      await runAdb(adbKeyeventArgs(serial, code)).catch((e) => log(`android key failed: ${(e as Error).message}`));
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
  ipcMain.handle("devloop:reload", (_e, hard: boolean) => manager.reload(!!hard));
  ipcMain.handle("devloop:back", () => manager.back());
  ipcMain.handle("devloop:forward", () => manager.forward());
  // pane-targeted (popped windows drive their own pane)
  ipcMain.handle("devloop:navigateFor", (_e, id: string, url: string) => manager.navigateFor(id, url));
  ipcMain.handle("devloop:backFor", (_e, id: string) => manager.backFor(id));
  ipcMain.handle("devloop:forwardFor", (_e, id: string) => manager.forwardFor(id));
  ipcMain.handle("devloop:reloadFor", (_e, id: string, hard: boolean) => manager.reloadFor(id, !!hard));
  ipcMain.handle("devloop:setBoundsFor", (_e, id: string, rect) => manager.setBoundsFor(id, rect));
  ipcMain.handle("devloop:screenshotFor", async (_e, id: string) => {
    const shot = await manager.screenshotFor(id);
    if (shot.base64)
      buffer.push("browser", "screenshot", "screenshot", { image: `data:${shot.mimeType};base64,${shot.base64}` }, id);
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
  ipcMain.handle("devloop:extInstall", (_e, input: string) => doExtInstall(String(input)));
  ipcMain.handle("devloop:extLoadUnpacked", async () => {
    const r = await dialog.showOpenDialog(shellWin!, {
      properties: ["openDirectory"],
      title: "Select an unpacked extension folder",
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const ext = await extSession().extensions.loadExtension(dir, { allowFileAccess: true });
    await loadExtIntoAll(dir); // also load into the other per-project sessions (#27)
    unpackedById.set(ext.id, dir);
    setUnpackedExtensions([...getUnpackedExtensions(), dir]);
    return extList();
  });
  // Toggle an extension on/off without uninstalling — disable unloads it from the
  // session (files stay); enable reloads it from disk. Persisted across launches.
  ipcMain.handle("devloop:extSetEnabled", (_e, id: string, enabled: boolean) => doExtSetEnabled(id, enabled));
  ipcMain.handle("devloop:extRemove", (_e, id: string) => doExtRemove(id));
  ipcMain.handle("devloop:screenshot", async () => {
    const shot = await manager.screenshot(false);
    const active = manager.listPanes().find((p) => p.active);
    buffer.push(
      "browser",
      "screenshot",
      "screenshot",
      { image: `data:${shot.mimeType};base64,${shot.base64}` },
      active?.id,
    );
  });
  // #25 viewport/throttle picker → the same browser_emulate / browser_throttle the MCP tools drive.
  ipcMain.handle("devloop:emulate", (_e, opts: { device?: string; reset?: boolean }) => manager.emulate(opts ?? {}));
  ipcMain.handle("devloop:throttle", (_e, profile: string) => manager.throttle(profile));

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
    await manager.setDevConfig(undefined, p.cmd, p.cwd);
    if (manager.devStatus().running) await manager.devRestart();
    else await manager.devStart(undefined, p.cmd, p.cwd);
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
const extSession = () => session.fromPartition(DEFAULT_PARTITION);
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
    // Inject our own "Add to Devloop" button — Google greys the native "Add to
    // Chrome" for non-Chrome browsers, so we install via the direct-CRX path instead.
    webPreferences: {
      partition: DEFAULT_PARTITION,
      contextIsolation: true,
      sandbox: false,
      preload: join(BASE, "extStorePreload.cjs"),
    },
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
  const loaded = extSession()
    .extensions.getAllExtensions()
    .map((e) => ({ id: e.id, name: e.name, version: e.version }));
  const disabled = getDisabledExtensions()
    .map(extMeta)
    .filter((m): m is ExtMeta => !!m);
  return unifyExtensions(loaded, disabled);
};

// Partitions whose extensions are already set up (#27 — one session per project). The
// default partition is the canonical set; project sessions get the same extensions loaded.
const preparedPartitions = new Set<string>();

/** Prepare a session partition (idempotent): load all installed extensions + the Web Store
 *  hook into it, so a per-project pane has the same extensions as the default. */
async function prepareSession(partition: string): Promise<void> {
  if (preparedPartitions.has(partition)) return;
  preparedPartitions.add(partition);
  await setupExtensionsFor(session.fromPartition(partition));
}

/** Run `fn` against every prepared session (so install/remove/toggle apply everywhere). */
async function eachExtSession(
  fn: (ses: ReturnType<typeof session.fromPartition>) => Promise<void> | void,
): Promise<void> {
  for (const partition of preparedPartitions) await fn(session.fromPartition(partition));
}

/** Load an extension dir into every prepared session (best-effort; an already-loaded one throws → ignored). */
async function loadExtIntoAll(dir: string): Promise<void> {
  await eachExtSession(async (ses) => {
    try {
      await ses.extensions.loadExtension(dir, { allowFileAccess: true });
    } catch {
      /* already loaded in this session, or bad dir */
    }
  });
}

/** Unload an extension id from every prepared session (loading it first if needed, so a
 *  disabled store extension's persisted settings entry is actually purged). */
async function purgeExtFromAll(id: string): Promise<void> {
  await eachExtSession(async (ses) => {
    if (!ses.extensions.getExtension(id)) {
      const dir = extDir(id);
      if (dir) {
        try {
          await ses.extensions.loadExtension(dir, { allowFileAccess: true });
        } catch {
          /* can't load — removeExtension below will just no-op */
        }
      }
    }
    try {
      ses.extensions.removeExtension(id);
    } catch {
      /* not loaded */
    }
  });
}

// Extension operations shared by the cockpit IPC handlers and the MCP ext_* tools.
async function doExtInstall(input: string) {
  const id = extensionIdFromInput(String(input));
  if (!id) throw new Error("not a valid extension id or Chrome Web Store URL");
  await installExtension(id, { session: extSession(), extensionsPath: EXT_DIR }); // downloads + loads into default
  const dir = extDir(id);
  if (dir) await loadExtIntoAll(dir); // mirror into every other per-project session (#27)
  return extList();
}
async function doExtSetEnabled(id: string, enabled: boolean) {
  const disabled = new Set(getDisabledExtensions());
  if (enabled) {
    const dir = extDir(id);
    if (dir) await loadExtIntoAll(dir);
    disabled.delete(id);
  } else {
    await purgeExtFromAll(id);
    disabled.add(id);
  }
  setDisabledExtensions([...disabled]);
  return extList();
}
async function doExtRemove(id: string) {
  setDisabledExtensions(getDisabledExtensions().filter((x) => x !== id));
  await purgeExtFromAll(id); // unload from every per-project session (#27), purging persisted settings
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
  if (extWin && !extWin.isDestroyed()) extWin.webContents.send("chrome.management.onUninstalled", id);
  return extList();
}

async function initExtensions(): Promise<void> {
  await prepareSession(DEFAULT_PARTITION); // the default/Web Store session, set up before panes navigate
}

async function setupExtensionsFor(ses: ReturnType<typeof session.fromPartition>): Promise<void> {
  // Enable the real Chrome Web Store inside this session: this intercepts
  // the store's "Add to Chrome" button and installs into EXT_DIR. It registers
  // its own preload (chrome-web-store.preload.js, copied beside main.cjs by the
  // build) into this session. loadExtensions:false — we load persisted ones below.
  try {
    // modulePath → the lib loads its preload from `<BASE>/dist/chrome-web-store.preload.js`
    // (build.ts copies it there). Without it, the bundled lib resolves a non-existent
    // source path and every pane logs "Unable to load preload script".
    await installChromeWebStore({
      session: ses,
      extensionsPath: EXT_DIR,
      loadExtensions: false,
      allowUnpackedExtensions: true,
      modulePath: BASE,
    });
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
  if (kind !== "react-native")
    return { isNative: false, platforms: [], targets: [], buildStatus: "unknown", badge: null };
  const webCapable = !!(deps["expo"] || deps["react-native-web"]); // Expo / RNW → has a Web target
  const iosCapable = process.platform === "darwin"; // iOS simulator + idb are macOS-only
  const current = await computeFingerprint(cwd);
  return resolveNativeInfo(kind, probe, current, getProjectFingerprint(cwd), webCapable, iosCapable);
}

// --- boot ------------------------------------------------------------------
async function main() {
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
    {
      indexPath: join(BASE, "renderer/index.html"),
      preloadPath: join(BASE, "preload.cjs"),
      simPreloadPath: join(BASE, "simPreload.cjs"),
    },
    prepareSession, // #27: load extensions into each per-project session before its pane navigates
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
  configureTools({
    buffer,
    browser: manager,
    devServer: devFacade,
    nativeEnv: () => {
      const p = probeNativeEnv();
      return { ready: nativeEnvReady(p), summary: nativeEnvSummary(p) };
    },
    // native_open / native_close / native_build over MCP — same path as the cockpit buttons.
    nativeControl: {
      open: (platform) => (platform === "android" ? doOpenAndroid() : doOpenSimulator()),
      close: async () => {
        await doCloseSimulator();
        await doCloseAndroid();
      },
      build: async (platform, cwd, eas) => doNativeBuild(platform as Platform, cwd, eas),
    },
    // ext_* over MCP — same path as the cockpit's Settings "ext" row.
    extControl: {
      list: () => extList(),
      install: (input) => doExtInstall(input),
      remove: (id) => doExtRemove(id),
      setEnabled: (id, enabled) => doExtSetEnabled(id, enabled),
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
      extSession,
      loadExtIntoAll,
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
