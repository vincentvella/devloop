import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, launchApp } from "../harness.ts";

/** Persistence/restore needs an app restart, so it runs its own launch cycle with a
 *  shared DEVLOOP_HOME (panes.json lives there) but a fresh Chromium profile. */
export async function persistence(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "devloop-gui-persist-"));
  const ud1 = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  const ud2 = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  try {
    let app = await launchApp(home, ud1);
    let win = await app.firstWindow();
    await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
    await win.click('[data-testid="pane-add"]');
    await win.locator(".tab.active").dblclick();
    await win.locator(".tab.active input.edit").fill("persist-marker");
    await win.locator(".tab.active input.edit").press("Enter");
    await win.waitForTimeout(800); // let panes.json persist
    await app.close();

    app = await launchApp(home, ud2);
    win = await app.firstWindow();
    await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
    await win.waitForTimeout(800);
    const labels = await win.locator(".tab .name").allTextContents();
    check("panes restore across relaunch", labels.some((l) => l.includes("persist-marker")), labels.join(","));
    await app.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ud1, { recursive: true, force: true });
    rmSync(ud2, { recursive: true, force: true });
  }
}
