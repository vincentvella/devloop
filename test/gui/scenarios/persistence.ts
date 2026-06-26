import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, launchReady } from "../harness.ts";

/** Persistence/restore needs an app restart, so it runs its own launch cycle with a
 *  shared DEVLOOP_HOME (panes.json lives there) but a fresh Chromium profile. */
export async function persistence(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "devloop-gui-persist-"));
  const ud1 = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  const ud2 = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  try {
    let { app, win } = await launchReady(home, ud1);
    await win.click('[data-testid="pane-add"]');
    await win.waitForTimeout(300);
    // Double-click to open the inline rename editor; retry — on a slow runner the
    // first dblclick can land before the tab is interactive (the editor never opens
    // → press times out).
    const edit = win.locator(".tab.active input.edit");
    for (let i = 0; i < 4 && (await edit.count()) === 0; i++) {
      await win.locator(".tab.active").dblclick();
      await win.waitForTimeout(400);
    }
    await edit.waitFor({ timeout: 10_000 });
    await edit.fill("persist-marker");
    await edit.press("Enter");
    await win.waitForTimeout(800); // let panes.json persist
    await app.close();

    ({ app, win } = await launchReady(home, ud2));
    await win.waitForTimeout(800);
    const labels = await win.locator(".tab .name").allTextContents();
    check(
      "panes restore across relaunch",
      labels.some((l) => l.includes("persist-marker")),
      labels.join(","),
    );
    await app.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ud1, { recursive: true, force: true });
    rmSync(ud2, { recursive: true, force: true });
  }
}
