import type { ElectronApplication, Page } from "playwright-core";
import {
  activePane,
  check,
  closeWrench,
  FIXTURE,
  newBlankPane,
  panes,
  setDevConfig,
  tabCount,
  waitForActive,
} from "../harness.ts";

export async function shellAndPanes(_app: ElectronApplication, win: Page): Promise<void> {
  await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
  check("shell renderer mounts", true);

  const before = await tabCount(win);
  await newBlankPane(win);
  await win.waitForFunction((n) => document.querySelectorAll(".tab:not(.add)").length === n + 1, before, {
    timeout: 10_000,
  });
  check("add pane adds a tab", (await tabCount(win)) === before + 1, `${before}→${before + 1}`);

  await win.locator(".tab.active").dblclick();
  const edit = win.locator(".tab.active input.edit");
  await edit.fill("renamed-pane");
  await edit.press("Enter");
  await win
    .waitForFunction(
      () => document.querySelector(".tab.active .name")?.textContent?.includes("renamed-pane") ?? false,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {});
  check(
    "rename pane updates the tab label",
    ((await win.locator(".tab.active .name").first().textContent()) ?? "").includes("renamed-pane"),
  );

  const n = await tabCount(win);
  await win.locator(".tab.active .x").click();
  await win.waitForFunction((c) => document.querySelectorAll(".tab:not(.add)").length === c - 1, n, {
    timeout: 10_000,
  });
  check("close pane removes the tab", (await tabCount(win)) === n - 1);
}

export async function multiPane(_app: ElectronApplication, win: Page): Promise<void> {
  const firstUrl = (await activePane(win))?.url || "";
  await newBlankPane(win); // new pane becomes active
  await setDevConfig(win, "node server.mjs", FIXTURE);
  await closeWrench(win);
  await win.getByLabel("start / stop dev server").click();
  const ap = await waitForActive(
    win,
    (p) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(p.url || "") && p.url !== firstUrl,
    30_000,
  );
  const all = await panes(win);
  const running = all.filter((p) => p.dev?.running);
  const distinct = new Set(running.map((p) => p.url)).size === running.length;
  check(
    "two panes run independent dev servers on distinct URLs",
    running.length >= 2 && distinct,
    `running=${running.length} thisUrl=${ap?.url}`,
  );
}

export async function popOut(app: ElectronApplication, win: Page): Promise<void> {
  const before = app.windows().length;
  const popupP = app.waitForEvent("window", { timeout: 10_000 }).catch(() => null);
  await win.getByLabel("pop active pane into its own window").click();
  const popup = await popupP;
  check("pop-out opens a separate window", !!popup && app.windows().length > before);
  if (popup) {
    await popup
      .locator(".address, input.address")
      .first()
      .waitFor({ timeout: 8_000 })
      .catch(() => {});
    check("popped window has its own browser bar", (await popup.locator("input.address").count()) > 0);
    // Close from the main process so the BrowserWindow 'close' event fires (→ dockPane).
    // Playwright's page.close() can tear down the page without firing Electron's 'close'.
    // Match the pop window by its ?pop= URL (the renderer overrides the window title).
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes("pop=")) w.close();
      }
    });
    const redocked = await waitForActive(win, (p) => !p.popped, 8_000);
    check("closing the popped window re-docks the pane", !!redocked);
  }
}
