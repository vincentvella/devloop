import type { ElectronApplication, Page } from "playwright-core";
import { check, closeWrench, ctx, FIXTURE, setDevConfig, waitForActive } from "../harness.ts";

export async function devServerAndLogs(_app: ElectronApplication, win: Page): Promise<void> {
  await setDevConfig(win, "node server.mjs", FIXTURE);
  await closeWrench(win);
  await win.getByLabel("start / stop dev server").click();
  const ap = await waitForActive(win, (p) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(p.url || ""), 30_000);
  ctx.fixtureOrigin = ap?.url ? new URL(ap.url).origin : "";
  check("dev server auto-navigates the pane to its URL", !!ap, ap?.url ?? "(no localhost url)");

  await win.locator("#list .logrow", { hasText: "fixture: page loaded" }).first().waitFor({ timeout: 15_000 });
  check("page console logs land in the timeline", true);
  await win.locator("#list .logrow", { hasText: "/api/fail" }).first().waitFor({ timeout: 15_000 });
  check("failed network request is captured on the timeline", true);
}

export async function devServerStop(_app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("start / stop dev server").click(); // toggles the active pane's server off
  const ap = await waitForActive(win, (p) => !p.dev?.running, 15_000);
  check("stop dev server clears running state", !!ap);
}
