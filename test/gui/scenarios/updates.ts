import type { ElectronApplication, Page } from "playwright-core";
import { check } from "../harness.ts";

/** The real auto-updater is disabled in dev, so inject status events on the update
 *  channel to verify the in-app indicator (preload → renderer pill) is wired up. */
export async function updateFeedback(app: ElectronApplication, win: Page): Promise<void> {
  const send = (status: unknown): Promise<void> =>
    app.evaluate(({ BrowserWindow }, s) => {
      const shell = BrowserWindow.getAllWindows().find((w) => {
        const u = w.webContents.getURL();
        return u.includes("index.html") && !u.includes("pop=");
      });
      shell?.webContents.send("devloop:update", s);
    }, status);

  await send({ state: "downloading", version: "9.9.9", percent: 42 });
  await win.locator(".update-pill.update-downloading", { hasText: "Downloading 9.9.9… 42%" }).waitFor({ timeout: 8_000 });
  check("update download progress shows in the top bar", (await win.locator(".update-fill").count()) > 0);

  await send({ state: "downloaded", version: "9.9.9" });
  await win.locator(".update-pill.update-downloaded", { hasText: "ready — restart" }).waitFor({ timeout: 8_000 });
  check("update-ready state shows in the top bar", true);

  await send({ state: "idle" });
  await win.waitForFunction(() => document.querySelectorAll(".update-pill").length === 0, undefined, { timeout: 8_000 });
  check("update indicator clears on idle", (await win.locator(".update-pill").count()) === 0);
}
