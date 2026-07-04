/**
 * IPC wiring for the cockpit's timeline renderer. Extracted from main.ts as a
 * single `registerIpc(deps)` that installs every `ipcMain.handle` channel. Deps
 * carry the mutable main-process singletons (via lazy getters where they're
 * assigned during boot) plus the extension + native-target handles.
 */
import { writeFileSync } from "node:fs";
import { app, type BrowserWindow, dialog, ipcMain, shell } from "electron";
import { adbKeyeventArgs, adbTapArgs, adbTextArgs, androidKeycodeFor } from "../src/adb.ts";
import { bundleToHtml } from "../src/bundle.ts";
import { blankIssueUrl } from "../src/crashReport.ts";
import { projectName } from "../src/devServer.ts";
import type { LogBuffer } from "../src/logBuffer.ts";
import type { Platform } from "../src/nativeBuild.ts";
import {
  androidBuildChecks,
  androidBuildReady,
  androidBuildSummary,
  androidEnvChecks,
  androidEnvReady,
  androidEnvSummary,
  nativeEnvChecks,
  nativeEnvReady,
} from "../src/nativeEnv.ts";
import type { Project, Session } from "../src/registry.ts";
import { handleTool } from "../src/toolLayer.ts";
import type { BrowserManager } from "./browserManager.ts";
import type { ExtensionManager } from "./extensions.ts";
import type { NativeTargets } from "./nativeTargets.ts";
import type { Updater } from "./updater.ts";

export interface RegisterIpcDeps {
  buffer: LogBuffer;
  getManager: () => BrowserManager;
  getShellWin: () => BrowserWindow | undefined;
  log: (m: string) => void;
  getUpdater: () => Updater | undefined;
  exts: ExtensionManager;
  native: NativeTargets;
  // Project registry
  listProjects: () => Project[];
  addProject: (p: Project) => Project[];
  getProject: (name: string) => Project | undefined;
  getSession: () => Session;
  setSession: (s: Session) => void;
}

// --- IPC for the timeline renderer ----------------------------------------
export function registerIpc(deps: RegisterIpcDeps): void {
  const { buffer, getManager, getShellWin, log, getUpdater, exts, native } = deps;
  const { listProjects, addProject, getProject, getSession, setSession } = deps;

  ipcMain.handle("devloop:getLogs", (_e, opts) => buffer.query(opts ?? {}));
  ipcMain.handle("devloop:clear", () => {
    buffer.clear();
    return true;
  });
  ipcMain.handle("devloop:navigate", (_e, url: string) => getManager().navigate(url));
  ipcMain.handle("devloop:nativeElements", async () => {
    // The native (idb) a11y snapshot for the iOS picker — routed to the RN controller
    // while the simulator target is active. Returns [] off-native or on error.
    try {
      return (await getManager().snapshot()).nodes;
    } catch {
      return [];
    }
  });
  ipcMain.handle("devloop:nativeEnv", () => {
    const probe = native.probeNativeEnv();
    return { ready: nativeEnvReady(probe), checks: nativeEnvChecks(probe) };
  });
  ipcMain.handle("devloop:checkForUpdates", () => getUpdater()?.check(true));
  ipcMain.handle("devloop:updateDownload", () => getUpdater()?.download());
  ipcMain.handle("devloop:updateInstall", () => getUpdater()?.install());
  ipcMain.handle("devloop:openExtensions", () => exts.openExtensionsWindow());
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
  ipcMain.handle("devloop:nativeInfo", (_e, cwd: string) => native.nativeInfo(cwd));
  ipcMain.handle("devloop:nativeBuild", (_e, cwd: string, platform: Platform) => native.doNativeBuild(platform, cwd));
  // Simulator: serve-sim's interactive MJPEG preview in a pane view (see doOpenSimulator).
  ipcMain.handle("devloop:openSimulator", () => native.doOpenSimulator());
  ipcMain.handle("devloop:closeSimulator", async () => {
    await native.doCloseSimulator();
    return { ok: true };
  });

  // --- Android: drive an emulator/device + mirror its screen into the pane ---
  ipcMain.handle("devloop:androidEnv", () => {
    const probe = native.probeAndroidEnv();
    return { ready: androidEnvReady(probe), checks: androidEnvChecks(probe), summary: androidEnvSummary(probe) };
  });
  ipcMain.handle("devloop:androidBuild", () => {
    const probe = native.probeAndroidBuild();
    return { ready: androidBuildReady(probe), checks: androidBuildChecks(probe), summary: androidBuildSummary(probe) };
  });
  ipcMain.handle("devloop:doctor", () => native.doctor());
  ipcMain.handle("devloop:nativeSystemLogs", (_e, on: boolean) => native.setSystemLogs(on));
  ipcMain.handle("devloop:openAndroid", () => native.doOpenAndroid());
  ipcMain.handle("devloop:closeAndroid", async () => {
    await native.doCloseAndroid();
    return { ok: true };
  });
  // Input from the mirror's click/key layer → adb. Coordinates arrive in device px.
  ipcMain.handle("devloop:androidTap", async (_e, x: number, y: number) => {
    const serial = native.firstAndroidSerial();
    if (serial)
      await native.runAdb(adbTapArgs(serial, x, y)).catch((e) => log(`android tap failed: ${(e as Error).message}`));
  });
  ipcMain.handle("devloop:androidText", async (_e, text: string) => {
    const serial = native.firstAndroidSerial();
    if (serial && text)
      await native.runAdb(adbTextArgs(serial, text)).catch((e) => log(`android text failed: ${(e as Error).message}`));
  });
  ipcMain.handle("devloop:androidKey", async (_e, key: string) => {
    const serial = native.firstAndroidSerial();
    const code = androidKeycodeFor(key);
    if (serial && code != null)
      await native
        .runAdb(adbKeyeventArgs(serial, code))
        .catch((e) => log(`android key failed: ${(e as Error).message}`));
  });

  // Per-pane dev lifecycle (top-bar controls act on the active pane).
  ipcMain.handle("devloop:devStatus", () => getManager().devStatus());
  ipcMain.handle("devloop:devStart", async (_e, opts: { cmd?: string; cwd?: string }) => {
    await getManager().ensureActive();
    return getManager().devStart(undefined, opts?.cmd || undefined, opts?.cwd || undefined);
  });
  ipcMain.handle("devloop:devStop", () => getManager().devStop());
  ipcMain.handle("devloop:devRestart", () => getManager().devRestart());
  ipcMain.handle("devloop:setDevConfig", async (_e, opts: { cmd?: string; cwd?: string }) => {
    await getManager().ensureActive();
    return getManager().setDevConfig(undefined, opts?.cmd || undefined, opts?.cwd || undefined);
  });
  ipcMain.handle("devloop:reload", (_e, hard: boolean) => getManager().reload(!!hard));
  ipcMain.handle("devloop:back", () => getManager().back());
  ipcMain.handle("devloop:forward", () => getManager().forward());
  // pane-targeted (popped windows drive their own pane)
  ipcMain.handle("devloop:navigateFor", (_e, id: string, url: string) => getManager().navigateFor(id, url));
  ipcMain.handle("devloop:backFor", (_e, id: string) => getManager().backFor(id));
  ipcMain.handle("devloop:forwardFor", (_e, id: string) => getManager().forwardFor(id));
  ipcMain.handle("devloop:reloadFor", (_e, id: string, hard: boolean) => getManager().reloadFor(id, !!hard));
  ipcMain.handle("devloop:setBoundsFor", (_e, id: string, rect) => getManager().setBoundsFor(id, rect));
  ipcMain.handle("devloop:screenshotFor", async (_e, id: string) => {
    const shot = await getManager().screenshotFor(id);
    if (shot.base64)
      buffer.push("browser", "screenshot", "screenshot", { image: `data:${shot.mimeType};base64,${shot.base64}` }, id);
  });
  ipcMain.handle("devloop:pick", () => getManager().pick());
  ipcMain.handle("devloop:clearStorage", (_e, opts) => getManager().clearStorage(opts));
  ipcMain.handle("devloop:exportHar", async () => {
    const res = await handleTool("export_har", {});
    const har = (res.content[0] as { text?: string })?.text ?? "{}";
    const { canceled, filePath } = await dialog.showSaveDialog(getShellWin()!, {
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
    const { canceled, filePath } = await dialog.showSaveDialog(getShellWin()!, {
      defaultPath: "devloop-report.html",
      filters: [{ name: "HTML report", extensions: ["html"] }],
    });
    if (canceled || !filePath) return null;
    writeFileSync(filePath, html);
    return filePath;
  });
  // --- extensions ---
  ipcMain.handle("devloop:extList", () => exts.extList());
  ipcMain.handle("devloop:extInstall", (_e, input: string) => exts.doExtInstall(String(input)));
  ipcMain.handle("devloop:extLoadUnpacked", async () => {
    const r = await dialog.showOpenDialog(getShellWin()!, {
      properties: ["openDirectory"],
      title: "Select an unpacked extension folder",
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return exts.loadUnpacked(r.filePaths[0]);
  });
  // Toggle an extension on/off without uninstalling — disable unloads it from the
  // session (files stay); enable reloads it from disk. Persisted across launches.
  ipcMain.handle("devloop:extSetEnabled", (_e, id: string, enabled: boolean) => exts.doExtSetEnabled(id, enabled));
  ipcMain.handle("devloop:extRemove", (_e, id: string) => exts.doExtRemove(id));
  ipcMain.handle("devloop:screenshot", async () => {
    const shot = await getManager().screenshot(false);
    const active = getManager()
      .listPanes()
      .find((p) => p.active);
    buffer.push(
      "browser",
      "screenshot",
      "screenshot",
      { image: `data:${shot.mimeType};base64,${shot.base64}` },
      active?.id,
    );
  });
  // #25 viewport/throttle picker → the same browser_emulate / browser_throttle the MCP tools drive.
  ipcMain.handle("devloop:emulate", (_e, opts: { device?: string; reset?: boolean }) =>
    getManager().emulate(opts ?? {}),
  );
  ipcMain.handle("devloop:throttle", (_e, profile: string) => getManager().throttle(profile));

  ipcMain.handle("devloop:pickFolder", async () => {
    const r = await dialog.showOpenDialog(getShellWin()!, { properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  // Project registry
  ipcMain.handle("devloop:projects", () => listProjects());
  ipcMain.handle("devloop:projectAdd", (_e, p) => addProject(p));
  // Multi-target panes
  ipcMain.handle("devloop:panes", () => getManager().listPanes());
  ipcMain.handle("devloop:paneNew", (_e, url?: string) => getManager().newPane(url));
  ipcMain.handle("devloop:paneSelect", (_e, id: string) => getManager().selectPane(id));
  ipcMain.handle("devloop:paneClose", (_e, id: string) => getManager().closePane(id));
  ipcMain.handle("devloop:panePop", (_e, id: string) => getManager().popPane(id));
  ipcMain.handle("devloop:paneSetLabel", (_e, id: string, label: string) => getManager().setLabel(id, label));
  // Renderer reports the #browserarea rect; reposition the embedded active pane.
  ipcMain.handle("devloop:setBounds", (_e, rect) => getManager().setBounds(rect));
  ipcMain.handle("devloop:overlay", (_e, on: boolean) => {
    return getManager().setOverlay(!!on);
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
    await getManager().ensureActive(); // open into a pane even if all were closed
    const label = projectName(p.cwd);
    // Configure + start this project on the ACTIVE pane; auto-navigate (or use saved url).
    await getManager().setDevConfig(undefined, p.cmd, p.cwd);
    if (getManager().devStatus().running) await getManager().devRestart();
    else await getManager().devStart(undefined, p.cmd, p.cwd);
    if (p.url) await getManager().navigate(p.url);
    return { dev: getManager().devStatus(), url: p.url ?? null, name: label };
  });
}
