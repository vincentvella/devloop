import type { ElectronApplication, Page } from "playwright-core";
import { check } from "../harness.ts";

/** The real auto-updater is disabled in dev, so inject status events on the update
 *  channel to verify the in-app update banner (preload → renderer) is wired up. */
export async function updateFeedback(app: ElectronApplication, win: Page): Promise<void> {
  const send = (status: unknown): Promise<void> =>
    app.evaluate(({ BrowserWindow }, s) => {
      const shell = BrowserWindow.getAllWindows().find((w) => {
        const u = w.webContents.getURL();
        return u.includes("index.html") && !u.includes("pop=");
      });
      shell?.webContents.send("devloop:update", s);
    }, status);

  await send({ state: "available", version: "9.9.9" });
  await win.locator(".update-banner", { hasText: "Devloop 9.9.9 available" }).waitFor({ timeout: 8_000 });
  check(
    "update banner offers Download when an update is available",
    (await win.locator(".update-btn.primary", { hasText: "Download" }).count()) > 0,
  );

  await send({ state: "downloading", version: "9.9.9", percent: 42 });
  await win.locator(".update-banner", { hasText: "Downloading 9.9.9… 42%" }).waitFor({ timeout: 8_000 });
  check(
    "update banner shows a spinner + progress while downloading",
    (await win.locator(".update-spinner").count()) > 0 && (await win.locator(".update-progress-fill").count()) > 0,
  );

  await send({ state: "downloaded", version: "9.9.9" });
  await win.locator(".update-btn.primary", { hasText: "Restart to install" }).waitFor({ timeout: 8_000 });
  check("update banner offers Restart when the update is ready", true);

  await send({ state: "idle" });
  await win.waitForFunction(() => document.querySelectorAll(".update-banner").length === 0, undefined, {
    timeout: 8_000,
  });
  check("update banner clears on idle", (await win.locator(".update-banner").count()) === 0);
}
