/**
 * GUI driver — end-to-end test of the cockpit's *renderer* through the real DOM.
 *
 * app:selftest exercises the tool layer + IPC handlers programmatically; it never
 * clicks the actual UI, which is how the extension-list remove bug slipped past it.
 * This driver launches the built Electron app via Playwright and drives the shell
 * renderer like a user — clicking buttons, reading rendered state — plus reaches
 * into the main process to assert side effects. Run after `bun run app:build`.
 *
 *   bun run app:gui            # build is run by the script
 *
 * macOS/Windows: launches a real window. Linux/CI: wrap in xvfb-run.
 * Exits non-zero on the first failed check.
 */
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

// Playwright's Electron control channel (the Node-inspector handshake it uses to
// drive the main process) hangs under bun's runtime — even though bun's WebSocket
// client is otherwise fine for plain ws and Chromium's CDP. Rather than patch
// Playwright's bundled internals (fragile across upgrades), transparently re-exec
// this driver under node when launched under bun. So `bun cockpit/gui-drive.ts`,
// `node cockpit/gui-drive.ts`, and `bun run app:gui` all work.
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  const r = spawnSync("node", [SELF, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const ROOT = join(dirname(SELF), "..");
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok]);
  console.log(`GUI ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "devloop-gui-"));
  const userData = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  let app: ElectronApplication | undefined;
  try {
    // --user-data-dir isolates this run's Chromium profile: no LevelDB lock
    // contention with a real Devloop instance, and concurrent runs don't collide.
    app = await electron.launch({
      args: ["out/main.cjs", `--user-data-dir=${userData}`],
      cwd: ROOT,
      env: { ...process.env, DEVLOOP_HOME: home, DEVLOOP_HTTP_PORT: "0" },
      timeout: 60_000,
    });

    // The first BrowserWindow is the cockpit shell (the React renderer).
    const win: Page = await app.firstWindow();
    await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
    check("shell renderer mounts", true);

    // Main-process sanity: it's really our app.
    const appName = await app.evaluate(({ app }) => app.getName());
    check("main process is Devloop", appName === "Devloop", `getName()=${appName}`);

    // Pane add/close through the real toolbar.
    const tabsBefore = await win.locator(".tab:not(.add)").count();
    await win.click('[data-testid="pane-add"]');
    await win.waitForFunction((n) => document.querySelectorAll(".tab:not(.add)").length === n + 1, tabsBefore, {
      timeout: 10_000,
    });
    const tabsAfter = await win.locator(".tab:not(.add)").count();
    check("add pane adds a tab", tabsAfter === tabsBefore + 1, `${tabsBefore}→${tabsAfter}`);

    // The new pane is also a real WebContentsView in the main process.
    const viewCount = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
    check("panes back the tabs with webContents", viewCount >= tabsAfter, `webContents=${viewCount}`);

    // Open Settings and assert the extensions area renders (the surface the bug lived on).
    await win.getByLabel("settings (⌘,) — extensions & updates").click();
    await win.waitForSelector('[data-testid="settings-panel"]', { timeout: 10_000 });
    const extAreaVisible =
      (await win.locator('[data-testid="ext-list"]').count()) > 0 ||
      (await win.locator('[data-testid="ext-empty"]').count()) > 0;
    check("settings opens with the extensions list", extAreaVisible);

    // The install-by-id/URL field (the dependable re-download path) is present + editable.
    const extInput = win.getByPlaceholder("…or paste a Web Store id / URL");
    await extInput.fill("test-id");
    check("ext install field is editable", (await extInput.inputValue()) === "test-id");

    await app.close();
    app = undefined;
  } finally {
    if (app) await app.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length) {
      console.log(`\nGUI DRIVE FAIL (${failed.length}): ${failed.map(([n]) => n).join(", ")}`);
      process.exit(1);
    }
    console.log(`\nGUI DRIVE OK (${checks.length} checks)`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("GUI DRIVE ERROR:", e);
    process.exit(1);
  });
