import type { ElectronApplication, Page } from "playwright-core";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, ctx, waitForActive } from "../harness.ts";

export async function logsFilter(_app: ElectronApplication, win: Page): Promise<void> {
  const filter = win.getByPlaceholder("filter (substring)…");
  await filter.fill("fixture: page loaded");
  await win.waitForTimeout(250);
  check("substring filter keeps matching rows", (await win.locator("#list .logrow").count()) >= 1);
  await filter.fill("zzz-definitely-not-present-xyz");
  await win.waitForTimeout(250);
  check("substring filter hides non-matching rows", (await win.locator("#list .logrow").count()) === 0);
  await filter.fill("");

  await win.locator(".chips .fchip", { hasText: "network" }).click();
  await win.waitForTimeout(250);
  const rows = await win.locator("#list .logrow").count();
  const allNetwork = await win.locator("#list .logrow .tag").evaluateAll((els) => els.length > 0 && els.every((e) => (e.textContent || "").includes("network")));
  check("network chip shows only network rows", rows >= 1 && allNetwork, `rows=${rows}`);
  await win.locator(".chips .fchip", { hasText: "network" }).click();
}

export async function screenshot(_app: ElectronApplication, win: Page): Promise<void> {
  const before = await win.locator("#list .logrow .shot").count();
  await win.getByLabel("screenshot → timeline").click();
  await win.waitForFunction((n) => document.querySelectorAll("#list .logrow .shot").length > n, before, { timeout: 15_000 });
  check("screenshot lands as a thumbnail on the timeline", (await win.locator("#list .logrow .shot").count()) > before);
}

export async function repro(_app: ElectronApplication, win: Page): Promise<void> {
  await win.locator(".chips, .filterbar").first().waitFor().catch(() => {});
  await win.locator("button.seg", { hasText: "repro" }).click(); // switch to the repro builder
  await win.locator("button.labeled", { hasText: "step" }).click(); // add a (navigate) step
  await win.locator(".steps input").first().fill(ctx.fixtureOrigin); // navigate target
  await win.waitForTimeout(150);
  await win.locator("button.labeled", { hasText: "run" }).click();
  // Results render inline in the timeline (the panel auto-switches to logs).
  await win.locator("#list .logrow", { hasText: "repro ·" }).first().waitFor({ timeout: 20_000 });
  check("repro builder runs and renders results inline", true);
}

export async function manualNavigation(_app: ElectronApplication, win: Page): Promise<void> {
  const target = `${ctx.fixtureOrigin}/api/ok`;
  const addr = win.locator(".browser-bar input.address");
  await addr.fill(target);
  await addr.press("Enter");
  const ap = await waitForActive(win, (p) => (p.url || "") === target, 15_000);
  check("address bar navigates the active pane", !!ap, ap?.url ?? target);
}

export async function exports(app: ElectronApplication, win: Page): Promise<void> {
  const harPath = join(tmpdir(), "devloop-gui-export.har");
  const htmlPath = join(tmpdir(), "devloop-gui-export.html");
  rmSync(harPath, { force: true });
  rmSync(htmlPath, { force: true });
  // Stub the native save dialog (Playwright can't drive native dialogs) to return known paths.
  await app.evaluate(({ dialog }, paths) => {
    let i = 0;
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({ canceled: false, filePath: paths[i++] });
  }, [harPath, htmlPath]);
  await win.getByTitle("export captured network as a HAR file").click();
  await win.waitForTimeout(800);
  check("HAR export writes a file", existsSync(harPath));
  await win.getByTitle("export a shareable bug report (HTML)").click();
  await win.waitForTimeout(800);
  check("report export writes an HTML file", existsSync(htmlPath));
  rmSync(harPath, { force: true });
  rmSync(htmlPath, { force: true });
}
