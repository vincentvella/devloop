import type { ElectronApplication, Page } from "playwright-core";
import { check, closeWrench, NATIVE_FIXTURE, setDevConfig } from "../harness.ts";

/** Point the active pane at a React Native project and drive the target switcher —
 *  the native detection path (nativeInfo → Web/iOS/Android) that the web fixtures never
 *  exercise. The fixture has react-native + react-native-web but no `expo`, so detection
 *  resolves without spawning `expo config` (runs in CI). web + android are
 *  platform-independent; iOS only appears on macOS. */
export async function nativeTargets(_app: ElectronApplication, win: Page): Promise<void> {
  await setDevConfig(win, "", NATIVE_FIXTURE);
  await closeWrench(win);

  // Detection resolves → the switcher appears in the toolbar.
  const sw = win.locator(".target-switch");
  await sw.waitFor({ timeout: 20_000 });
  check("RN project shows the target switcher", (await sw.count()) > 0);

  const labels = await sw.locator("button.seg").allTextContents();
  check(
    "switcher offers Web + Android targets",
    labels.includes("Web") && labels.includes("Android"),
    labels.join(","),
  );

  // Web is the default target and stays selectable (no simulator / adb needed).
  await sw.locator("button.seg", { hasText: "Web" }).click();
  const on = (await win.locator(".target-switch button.seg.on").textContent())?.trim();
  check("Web target is selected", on === "Web", on ?? "(none)");
}
