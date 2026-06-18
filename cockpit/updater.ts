/**
 * Auto-update for the cockpit, backed by electron-updater reading the
 * `latest*.yml` + signed `.zip`/installer feed we publish to GitHub Releases.
 *
 * Flow: on launch (and on demand) check GitHub → if a newer version exists,
 * prompt to download → once downloaded, prompt to restart-and-install. Nothing
 * downloads or installs without the user saying yes.
 *
 * Only meaningful in a packaged, signed build — in dev / selftest there's no
 * app-update.yml and macOS auto-update requires code signing, so we no-op.
 */
import { dialog, type BrowserWindow } from "electron";
import { isNewerVersion, updateAvailableMessage, updateReadyMessage, upToDateMessage, type UpdateStatus } from "../src/update.ts";

export interface Updater {
  /** Check GitHub for a newer release. `manual` shows an "up to date" dialog when there isn't one. */
  check: (manual?: boolean) => Promise<void>;
}

export function initAutoUpdate(opts: {
  win?: BrowserWindow;
  log: (msg: string) => void;
  enabled: boolean;
}): Updater {
  const { win, log, enabled } = opts;
  if (!enabled) {
    log("auto-update: disabled (dev/unpackaged/selftest)");
    return { check: async () => log("auto-update: check skipped (disabled)") };
  }

  // Lazy require so dev/test never loads electron-updater (it expects packaged metadata).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
  const current = autoUpdater.currentVersion.version;

  autoUpdater.autoDownload = false; // we prompt before downloading
  autoUpdater.autoInstallOnAppQuit = true; // if they pick "Later", install on next quit
  autoUpdater.logger = { info: log, warn: log, error: (m: unknown) => log(`error ${m}`), debug: () => {} } as never;

  let busy = false; // guards against overlapping prompts/downloads
  let downloadingVersion = "";

  // Push lifecycle to the renderer for an in-app indicator, and mirror download
  // progress onto the dock/taskbar progress bar. (-1 clears it.)
  const emit = (status: UpdateStatus): void => {
    win?.webContents.send("devloop:update", status);
    if (win && !win.isDestroyed()) {
      if (status.state === "downloading") win.setProgressBar(Math.max(0, Math.min(1, status.percent / 100)));
      else win.setProgressBar(-1);
    }
  };

  autoUpdater.on("error", (err: Error) => {
    log(`auto-update error: ${err?.message ?? err}`);
    emit({ state: "error", message: err?.message ?? String(err) });
  });

  autoUpdater.on("update-available", async (info: { version: string }) => {
    if (busy || !win) return;
    busy = true;
    log(`auto-update: ${info.version} available (on ${current})`);
    emit({ state: "available", version: info.version });
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `Devloop ${info.version} is available`,
      detail: updateAvailableMessage(current, info.version),
    });
    busy = false;
    if (response === 0) {
      log(`auto-update: downloading ${info.version}`);
      downloadingVersion = info.version;
      emit({ state: "downloading", version: info.version, percent: 0 });
      void autoUpdater.downloadUpdate();
    } else {
      emit({ state: "idle" });
    }
  });

  autoUpdater.on("download-progress", (p: { percent: number; bytesPerSecond: number }) => {
    emit({ state: "downloading", version: downloadingVersion, percent: p.percent, bytesPerSecond: p.bytesPerSecond });
  });

  autoUpdater.on("update-downloaded", async (info: { version: string }) => {
    emit({ state: "downloaded", version: info.version });
    if (!win) return;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Devloop ${info.version} is ready`,
      detail: updateReadyMessage(info.version),
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  const check = async (manual = false) => {
    try {
      if (manual) emit({ state: "checking" });
      const result = await autoUpdater.checkForUpdates();
      const remote = result?.updateInfo?.version;
      // When nothing is newer, electron-updater won't emit update-available; for a
      // user-initiated check, close the loop with explicit feedback.
      if (manual && win && (!remote || !isNewerVersion(current, remote))) {
        emit({ state: "uptodate", version: current });
        await dialog.showMessageBox(win, {
          type: "info",
          buttons: ["OK"],
          title: "No updates",
          message: "You're up to date",
          detail: upToDateMessage(current),
        });
      }
    } catch (err) {
      log(`auto-update: check failed: ${(err as Error)?.message ?? err}`);
      if (manual) emit({ state: "error", message: (err as Error)?.message ?? String(err) });
      if (manual && win) {
        await dialog.showMessageBox(win, {
          type: "warning",
          buttons: ["OK"],
          title: "Update check failed",
          message: "Couldn't check for updates",
          detail: String((err as Error)?.message ?? err),
        });
      }
    }
  };

  return { check };
}
