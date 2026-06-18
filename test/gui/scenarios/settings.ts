import type { ElectronApplication, Page } from "playwright-core";
import { check, closeWrench, DARK_READER, PANE_PARTITION, RUN_EXT_E2E } from "../harness.ts";

export async function projectRegistry(_app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("pane settings — project & dev server").click();
  await win.getByTitle("save the active pane as a project (rename on its tab)").click();
  await win.waitForTimeout(400);
  // The saved project (named from the pane label) appears in the project picker.
  const opts = await win.locator(".settings select option").allTextContents();
  check("saving a project adds it to the picker", opts.some((o) => o.includes("renamed-pane") || o.includes("devloop")), opts.filter(Boolean).join(","));
  await closeWrench(win);
}

export async function settingsAndExtensions(app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("settings (⌘,) — extensions & updates").click();
  await win.waitForSelector('[data-testid="settings-panel"]', { timeout: 10_000 });
  check("settings opens with the extensions list", (await win.locator('[data-testid="ext-list"], [data-testid="ext-empty"]').count()) > 0);

  const extInput = win.getByPlaceholder("Web Store link or extension id");
  await extInput.fill("test-id");
  check("ext install field is editable", (await extInput.inputValue()) === "test-id");
  await extInput.fill("");

  if (RUN_EXT_E2E) {
    const loaded = (part: string): Promise<boolean> =>
      app.evaluate(({ session }, p) => !!session.fromPartition(p).extensions.getExtension("eimadpbcbfnmbkopoojfekhnkhdbieeh"), part);
    await extInput.fill(DARK_READER);
    await win.getByTitle("install from the pasted id / URL").click();
    await win.waitForSelector(`[data-testid="ext-chip-${DARK_READER}"]`, { timeout: 60_000 });
    check("ext install by id adds the chip", await loaded(PANE_PARTITION));

    // Toggle off → chip gets the "off" class + unloaded from the session; toggle on → reloaded.
    await win.locator(`[data-testid="ext-chip-${DARK_READER}"] .ext-name`).click();
    await win.waitForTimeout(800);
    check("ext disable unloads it (chip dims)", !(await loaded(PANE_PARTITION)) && (await win.locator(`[data-testid="ext-chip-${DARK_READER}"].off`).count()) > 0);
    await win.locator(`[data-testid="ext-chip-${DARK_READER}"] .ext-name`).click();
    await win.waitForTimeout(800);
    check("ext enable reloads it", await loaded(PANE_PARTITION));

    // Remove → chip goes away AND it's unloaded (regression guard for the remove-hygiene fix).
    await win.locator(`[data-testid="ext-remove-${DARK_READER}"]`).click();
    await win.waitForSelector(`[data-testid="ext-chip-${DARK_READER}"]`, { state: "detached", timeout: 20_000 });
    check("ext remove unloads it from the session", !(await loaded(PANE_PARTITION)));
  }
  await win.keyboard.press("Escape");
}
