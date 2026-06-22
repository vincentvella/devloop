/**
 * Auto-update for the cockpit, backed by electron-updater reading the
 * `latest*.yml` + signed `.zip`/installer feed we publish to GitHub Releases.
 *
 * Flow: on launch (and on demand) check GitHub → push status to the renderer's
 * in-app update banner. The banner drives the decisions: Download when one's
 * available, Restart to install once downloaded. Nothing downloads or installs
 * without the user acting — no native dialogs.
 *
 * Only meaningful in a packaged, signed build — in dev / selftest there's no
 * app-update.yml and macOS auto-update requires code signing, so we no-op.
 */
import { type BrowserWindow } from "electron";
import { isNewerVersion, type UpdateStatus } from "../src/update.ts";

export interface Updater {
  /** Check GitHub for a newer release. `manual` surfaces an "up to date" banner when there isn't one. */
  check: (manual?: boolean) => Promise<void>;
  /** Start downloading the available update (driven by the banner's Download button). */
  download: () => void;
  /** Restart and install a downloaded update (the banner's Restart button). */
  install: () => void;
}

export function initAutoUpdate(opts: { win?: BrowserWindow; log: (msg: string) => void; enabled: boolean }): Updater {
  const { win, log, enabled } = opts;
  if (!enabled) {
    log("auto-update: disabled (dev/unpackaged/selftest)");
    return { check: async () => log("auto-update: check skipped (disabled)"), download: () => {}, install: () => {} };
  }

  // Lazy require so dev/test never loads electron-updater (it expects packaged metadata).
  const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
  const current = autoUpdater.currentVersion.version;

  autoUpdater.autoDownload = false; // the banner's Download button triggers it
  autoUpdater.autoInstallOnAppQuit = true; // if they don't restart now, install on next quit
  autoUpdater.logger = { info: log, warn: log, error: (m: unknown) => log(`error ${m}`), debug: () => {} } as never;

  let latestVersion = "";

  // Push lifecycle to the renderer's update banner, and mirror download progress
  // onto the dock/taskbar progress bar. (-1 clears it.)
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
  autoUpdater.on("update-available", (info: { version: string }) => {
    latestVersion = info.version;
    log(`auto-update: ${info.version} available (on ${current})`);
    emit({ state: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (p: { percent: number; bytesPerSecond: number }) => {
    emit({ state: "downloading", version: latestVersion, percent: p.percent, bytesPerSecond: p.bytesPerSecond });
  });
  autoUpdater.on("update-downloaded", (info: { version: string }) => {
    log(`auto-update: ${info.version} downloaded`);
    emit({ state: "downloaded", version: info.version });
  });

  const check = async (manual = false): Promise<void> => {
    try {
      if (manual) emit({ state: "checking" });
      const result = await autoUpdater.checkForUpdates();
      const remote = result?.updateInfo?.version;
      // When nothing is newer, electron-updater won't emit update-available; for a
      // user-initiated check, close the loop with explicit feedback.
      if (manual && (!remote || !isNewerVersion(current, remote))) emit({ state: "uptodate", version: current });
    } catch (err) {
      log(`auto-update: check failed: ${(err as Error)?.message ?? err}`);
      if (manual) emit({ state: "error", message: (err as Error)?.message ?? String(err) });
    }
  };

  const download = (): void => {
    log(`auto-update: downloading ${latestVersion}`);
    emit({ state: "downloading", version: latestVersion, percent: 0 });
    void autoUpdater.downloadUpdate();
  };
  const install = (): void => autoUpdater.quitAndInstall();

  return { check, download, install };
}
