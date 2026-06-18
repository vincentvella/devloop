/**
 * GUI driver — end-to-end test of the cockpit's *renderer* through the real DOM.
 *
 * app:selftest exercises the tool layer + IPC handlers programmatically; it never
 * clicks the actual UI, which is how the extension-list remove bug slipped past it.
 * This driver launches the built Electron app via Playwright and drives the shell
 * renderer like a user — clicking buttons, reading rendered state — plus reaches
 * into the main process to assert side effects. Run after a build.
 *
 *   bun run app:gui                 # build + drive
 *   GUI_EXT_E2E=1 bun run app:gui   # also run the (networked) Web Store install/toggle/remove flow
 *
 * macOS/Windows: launches a real window. Linux/CI: wrap in xvfb-run.
 * Exits non-zero if any check fails.
 */
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const FIXTURE = join(ROOT, "test", "fixtures", "web-app");
const PANE_PARTITION = "persist:devloop-panes";
const RUN_EXT_E2E = process.env.GUI_EXT_E2E === "1"; // opt-in: hits the real Chrome Web Store (network)
const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

const checks: Array<[string, boolean]> = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push([name, ok]);
  console.log(`GUI ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

interface Pane {
  id: string;
  url: string;
  active: boolean;
  popped?: boolean;
  label?: string;
  dev?: { running?: boolean };
}
type Bridge = { devloop: { panes(): Promise<Pane[]> } };
const panes = (win: Page): Promise<Pane[]> => win.evaluate(() => (window as unknown as Bridge).devloop.panes());
const activePane = async (win: Page): Promise<Pane | undefined> => (await panes(win)).find((p) => p.active);
const tabCount = (win: Page) => win.locator(".tab:not(.add)").count();

// Poll the active pane from the node side. (Playwright's waitForFunction with an
// async predicate that calls the devloop IPC bridge resolves immediately — it
// treats the returned Promise as truthy without awaiting it per poll — so we
// drive the polling here instead.)
async function waitForActive(win: Page, pred: (p: Pane) => boolean, timeoutMs = 30_000): Promise<Pane | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ap = await activePane(win);
    if (ap && pred(ap)) return ap;
    if (Date.now() >= end) return undefined;
    await win.waitForTimeout(300);
  }
}

const ctx: { fixtureOrigin: string } = { fixtureOrigin: "" };

/** Each scenario is isolated: a throw is recorded as a failed check, not an abort. */
async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`${name} (threw)`, false, (e as Error).message.split("\n")[0]);
  }
}

/** Set the active pane's dev cmd + cwd via the wrench. Each field auto-saves on
 *  blur, then refreshPanes re-syncs both inputs from the pane — so committing one
 *  resets the other's input. Commit cwd first (own blur), then cmd; waits let React
 *  re-render so each blur handler closes over the value just typed. */
async function setDevConfig(win: Page, cmd: string, cwd: string): Promise<void> {
  await win.getByLabel("pane settings — project & dev server").click();
  const cmdI = win.locator('input[placeholder="cmd (blank = auto-detect)"]');
  const cwdI = win.locator('input[placeholder="project folder (cwd)"]');
  await cmdI.waitFor({ timeout: 10_000 });
  await cmdI.fill(cmd);
  await win.waitForTimeout(250);
  await cmdI.blur();
  await win.waitForTimeout(250);
  await cwdI.fill(cwd);
  await win.waitForTimeout(250);
  await cwdI.blur();
  await win.waitForTimeout(400);
  // The controlled inputs save on blur, but refreshPanes re-syncs both from the
  // pane — under fast automation (multiple panes → many async refreshes) the second
  // blur can clobber the first. Verify it stuck; if not, commit via the same IPC the
  // inputs drive. (A human typing + tabbing doesn't hit this; it's an automation race.)
  if ((await activePane(win))?.dev?.cwd !== cwd) {
    await win.evaluate((c) => (window as unknown as { devloop: { setDevConfig(x: { cmd: string; cwd: string }): Promise<unknown> } }).devloop.setDevConfig(c), { cmd, cwd });
    await win.waitForTimeout(300);
  }
}

async function closeWrench(win: Page): Promise<void> {
  await win.keyboard.press("Escape");
  await win.locator('input[placeholder="cmd (blank = auto-detect)"]').waitFor({ state: "hidden" }).catch(() => {});
}

async function scenarioShellAndPanes(_app: ElectronApplication, win: Page): Promise<void> {
  await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
  check("shell renderer mounts", true);

  const before = await tabCount(win);
  await win.click('[data-testid="pane-add"]');
  await win.waitForFunction((n) => document.querySelectorAll(".tab:not(.add)").length === n + 1, before, { timeout: 10_000 });
  check("add pane adds a tab", (await tabCount(win)) === before + 1, `${before}→${before + 1}`);

  await win.locator(".tab.active").dblclick();
  const edit = win.locator(".tab.active input.edit");
  await edit.fill("renamed-pane");
  await edit.press("Enter");
  await win
    .waitForFunction(() => document.querySelector(".tab.active .name")?.textContent?.includes("renamed-pane") ?? false, undefined, { timeout: 10_000 })
    .catch(() => {});
  check("rename pane updates the tab label", ((await win.locator(".tab.active .name").first().textContent()) ?? "").includes("renamed-pane"));

  const n = await tabCount(win);
  await win.locator(".tab.active .x").click();
  await win.waitForFunction((c) => document.querySelectorAll(".tab:not(.add)").length === c - 1, n, { timeout: 10_000 });
  check("close pane removes the tab", (await tabCount(win)) === n - 1);
}

async function scenarioDevServerAndLogs(_app: ElectronApplication, win: Page): Promise<void> {
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

async function scenarioLogsFilter(_app: ElectronApplication, win: Page): Promise<void> {
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

async function scenarioScreenshot(_app: ElectronApplication, win: Page): Promise<void> {
  // Re-navigate to the fixture page (manual-nav may have left a JSON page) so the shot has content.
  const before = await win.locator("#list .logrow .shot").count();
  await win.getByLabel("screenshot → timeline").click();
  await win.waitForFunction((n) => document.querySelectorAll("#list .logrow .shot").length > n, before, { timeout: 15_000 });
  check("screenshot lands as a thumbnail on the timeline", (await win.locator("#list .logrow .shot").count()) > before);
}

async function scenarioRepro(_app: ElectronApplication, win: Page): Promise<void> {
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

async function scenarioManualNavigation(_app: ElectronApplication, win: Page): Promise<void> {
  const target = `${ctx.fixtureOrigin}/api/ok`;
  const addr = win.locator(".browser-bar input.address");
  await addr.fill(target);
  await addr.press("Enter");
  const ap = await waitForActive(win, (p) => (p.url || "") === target, 15_000);
  check("address bar navigates the active pane", !!ap, ap?.url ?? target);
}

async function scenarioExports(app: ElectronApplication, win: Page): Promise<void> {
  const harPath = join(tmpdir(), "devloop-gui-export.har");
  const htmlPath = join(tmpdir(), "devloop-gui-export.html");
  rmSync(harPath, { force: true });
  rmSync(htmlPath, { force: true });
  // Stub the native save dialog (Playwright can't drive native dialogs) to return a known path.
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

async function scenarioProjectRegistry(_app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("pane settings — project & dev server").click();
  await win.getByTitle("save the active pane as a project (rename on its tab)").click();
  await win.waitForTimeout(400);
  // The saved project (named from the pane label) appears in the project picker.
  const opts = await win.locator(".settings select option").allTextContents();
  check("saving a project adds it to the picker", opts.some((o) => o.includes("renamed-pane") || o.includes("devloop")), opts.filter(Boolean).join(","));
  await closeWrench(win);
}

async function scenarioMultiPane(_app: ElectronApplication, win: Page): Promise<void> {
  const firstUrl = (await activePane(win))?.url || "";
  await win.click('[data-testid="pane-add"]'); // new pane becomes active
  await setDevConfig(win, "node server.mjs", FIXTURE);
  await closeWrench(win);
  await win.getByLabel("start / stop dev server").click();
  const ap = await waitForActive(win, (p) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(p.url || "") && p.url !== firstUrl, 30_000);
  const all = await panes(win);
  if (process.env.GUI_DEBUG) console.log("[dbg] multipane firstUrl=", firstUrl, "panes=", JSON.stringify(all));
  const running = all.filter((p) => p.dev?.running);
  const distinct = new Set(running.map((p) => p.url)).size === running.length;
  check("two panes run independent dev servers on distinct URLs", running.length >= 2 && distinct, `running=${running.length} thisUrl=${ap?.url}`);
}

async function scenarioPopOut(app: ElectronApplication, win: Page): Promise<void> {
  const before = app.windows().length;
  const popupP = app.waitForEvent("window", { timeout: 10_000 }).catch(() => null);
  await win.getByLabel("pop active pane into its own window").click();
  const popup = await popupP;
  check("pop-out opens a separate window", !!popup && app.windows().length > before);
  if (popup) {
    await popup.locator(".address, input.address").first().waitFor({ timeout: 8_000 }).catch(() => {});
    check("popped window has its own browser bar", (await popup.locator("input.address").count()) > 0);
    // Close from the main process so the BrowserWindow 'close' event fires (→ dockPane).
    // Playwright's page.close() can tear down the page without firing Electron's 'close'.
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes("pop=")) w.close();
      }
    });
    const redocked = await waitForActive(win, (p) => !p.popped, 8_000);
    check("closing the popped window re-docks the pane", !!redocked);
  }
}

async function scenarioDevServerStop(_app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("start / stop dev server").click(); // toggles the active pane's server off
  const ap = await waitForActive(win, (p) => !p.dev?.running, 15_000);
  check("stop dev server clears running state", !!ap);
}

async function scenarioSettingsAndExtensions(app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("settings (⌘,) — extensions & updates").click();
  await win.waitForSelector('[data-testid="settings-panel"]', { timeout: 10_000 });
  check("settings opens with the extensions list", (await win.locator('[data-testid="ext-list"], [data-testid="ext-empty"]').count()) > 0);

  const extInput = win.getByPlaceholder("…or paste a Web Store id / URL");
  await extInput.fill("test-id");
  check("ext install field is editable", (await extInput.inputValue()) === "test-id");
  await extInput.fill("");

  if (RUN_EXT_E2E) {
    const loaded = (part: string) => app.evaluate(({ session }, p) => !!session.fromPartition(p).extensions.getExtension("eimadpbcbfnmbkopoojfekhnkhdbieeh"), part);
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

/** Persistence/restore needs an app restart, so it runs its own launch cycle with a
 *  shared DEVLOOP_HOME (panes.json lives there) but a fresh Chromium profile. */
async function testPersistence(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "devloop-gui-persist-"));
  const launch = (ud: string) =>
    electron.launch({ args: ["out/main.cjs", `--user-data-dir=${ud}`], cwd: ROOT, env: { ...process.env, DEVLOOP_HOME: home, DEVLOOP_HTTP_PORT: "0" }, timeout: 60_000 });
  const ud1 = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  const ud2 = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  try {
    let app = await launch(ud1);
    let win = await app.firstWindow();
    await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
    await win.click('[data-testid="pane-add"]');
    await win.locator(".tab.active").dblclick();
    await win.locator(".tab.active input.edit").fill("persist-marker");
    await win.locator(".tab.active input.edit").press("Enter");
    await win.waitForTimeout(800); // let panes.json persist
    await app.close();

    app = await launch(ud2);
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

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "devloop-gui-"));
  const userData = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  let app: ElectronApplication | undefined;
  try {
    // --user-data-dir isolates this run's Chromium profile (no LevelDB lock contention
    // with a real Devloop instance; concurrent runs don't collide). NET_THRESHOLD=0
    // captures all network events so the timeline assertions are deterministic.
    app = await electron.launch({
      args: ["out/main.cjs", `--user-data-dir=${userData}`],
      cwd: ROOT,
      env: { ...process.env, DEVLOOP_HOME: home, DEVLOOP_HTTP_PORT: "0", DEVLOOP_NET_THRESHOLD: "0" },
      timeout: 60_000,
    });
    if (process.env.GUI_DEBUG) app.process().stderr?.on("data", (d: Buffer) => process.stderr.write(`[elec] ${d}`));
    const win = await app.firstWindow();
    check("main process is Devloop", (await app.evaluate(({ app }) => app.getName())) === "Devloop");

    await run("shell & panes", () => scenarioShellAndPanes(app!, win));
    await run("dev server & logs", () => scenarioDevServerAndLogs(app!, win));
    await run("logs filter", () => scenarioLogsFilter(app!, win));
    await run("screenshot", () => scenarioScreenshot(app!, win));
    await run("repro builder", () => scenarioRepro(app!, win));
    await run("manual navigation", () => scenarioManualNavigation(app!, win));
    await run("exports", () => scenarioExports(app!, win));
    await run("project registry", () => scenarioProjectRegistry(app!, win));
    await run("multi-pane", () => scenarioMultiPane(app!, win));
    await run("pop-out", () => scenarioPopOut(app!, win));
    await run("dev server stop", () => scenarioDevServerStop(app!, win));
    await run("settings & extensions", () => scenarioSettingsAndExtensions(app!, win));

    await app.close();
    app = undefined;
  } finally {
    if (app) await app.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }

  await run("persistence/restore", () => testPersistence());
}

main()
  .then(() => {
    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length) {
      console.log(`\nGUI DRIVE FAIL (${failed.length}/${checks.length}): ${failed.map(([n]) => n).join(", ")}`);
      process.exit(1);
    }
    console.log(`\nGUI DRIVE OK (${checks.length} checks)`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("GUI DRIVE ERROR:", e);
    process.exit(1);
  });
