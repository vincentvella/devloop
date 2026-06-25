/**
 * Automated cockpit screenshots for the marketing site.
 *
 * Reuses the GUI test harness: launches the real Electron cockpit, drives it
 * against the bundled fixture web-app (panes + dev server + timeline), and
 * captures PNGs into site/shots/. Run: `bun run app:shots`
 * (opens a real window briefly — that's expected). Must run under node, not
 * bun — Playwright's Electron control channel hangs under bun's runtime.
 * Needs macOS Screen Recording permission for the capturing terminal.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { launchReady, ROOT, waitForActive } from "./harness.ts";
import { devServerAndLogs } from "./scenarios/devServer.ts";
import { repro } from "./scenarios/timeline.ts";
import { multiPane } from "./scenarios/panes.ts";

const SHOTS = join(ROOT, "site", "shots");
// A real, visually rich page for the browser pane (dogfooding) instead of the
// bare test fixture, so the pane isn't mostly empty in the captures.
const SHOWCASE_URL = "https://devloop.build";

// The browser panes are separate WebContentsViews layered over the React shell,
// which Playwright's DOM screenshot can't see. Capture the real OS window region
// (composited) via macOS screencapture instead. (Needs Screen Recording perms.)
async function captureWindow(app: ElectronApplication, win: Page, path: string): Promise<void> {
  const b = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
    w.moveTop();
    return w.getBounds();
  });
  await win.waitForTimeout(800);
  execFileSync("screencapture", ["-x", "-o", `-R${b.x},${b.y},${b.width},${b.height}`, path]);
}

async function navTo(win: Page, url: string): Promise<void> {
  const addr = win.locator(".browser-bar input.address");
  await addr.fill(url);
  await addr.press("Enter");
  await waitForActive(win, (p) => (p.url || "").startsWith(url), 20_000).catch(() => {});
  await win.waitForTimeout(2500); // let the page paint
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "devloop-shots-"));
  const userData = mkdtempSync(join(tmpdir(), "devloop-shots-ud-"));
  const { app, win } = await launchReady(home, userData, { DEVLOOP_NET_THRESHOLD: "0" });
  try {
    // A generous, fixed window size for crisp, consistent captures.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.setBounds({ x: 40, y: 40, width: 1600, height: 1000 });
    });
    await win.waitForTimeout(500);

    // 1) Cockpit: a pane showing a real app + the timeline full of correlated logs.
    await devServerAndLogs(app, win);
    await navTo(win, SHOWCASE_URL);
    await captureWindow(app, win, join(SHOTS, "cockpit.png"));
    console.log("✓ cockpit.png");

    // 2) repro builder + inline results (point the pane back at the app so it's rich).
    await repro(app, win);
    await navTo(win, SHOWCASE_URL);
    await captureWindow(app, win, join(SHOTS, "repro.png"));
    console.log("✓ repro.png");

    // 3) Multiple panes; point the active one at the app too so it isn't empty.
    await multiPane(app, win);
    await navTo(win, SHOWCASE_URL);
    await captureWindow(app, win, join(SHOTS, "multipane.png"));
    console.log("✓ multipane.png");
  } finally {
    await app.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
