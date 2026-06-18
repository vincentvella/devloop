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
 *   GUI_EXT_E2E=1 bun run app:gui   # also run the (networked) Web Store install/remove flow
 *
 * macOS/Windows: launches a real window. Linux/CI: wrap in xvfb-run.
 * Exits non-zero if any check fails.
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
  dev?: { running?: boolean };
}
const panes = (win: Page): Promise<Pane[]> => win.evaluate(() => (window as unknown as { devloop: { panes(): Promise<Pane[]> } }).devloop.panes());
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

async function scenarioShellAndPanes(_app: ElectronApplication, win: Page): Promise<void> {
  await win.waitForSelector('[data-testid="pane-add"]', { timeout: 20_000 });
  check("shell renderer mounts", true);

  const before = await tabCount(win);
  await win.click('[data-testid="pane-add"]');
  await win.waitForFunction((n) => document.querySelectorAll(".tab:not(.add)").length === n + 1, before, { timeout: 10_000 });
  check("add pane adds a tab", (await tabCount(win)) === before + 1, `${before}→${before + 1}`);

  // Rename the active tab: double-click → inline input → Enter.
  await win.locator(".tab.active").dblclick();
  const edit = win.locator(".tab.active input.edit");
  await edit.fill("renamed-pane");
  await edit.press("Enter");
  await win
    .waitForFunction(() => document.querySelector(".tab.active .name")?.textContent?.includes("renamed-pane") ?? false, undefined, { timeout: 10_000 })
    .catch(() => {});
  check("rename pane updates the tab label", ((await win.locator(".tab.active .name").first().textContent()) ?? "").includes("renamed-pane"));

  // Close the active pane back toward baseline.
  const n = await tabCount(win);
  await win.locator(".tab.active .x").click();
  await win.waitForFunction((c) => document.querySelectorAll(".tab:not(.add)").length === c - 1, n, { timeout: 10_000 });
  check("close pane removes the tab", (await tabCount(win)) === n - 1);
}

async function scenarioDevServerAndLogs(_app: ElectronApplication, win: Page): Promise<void> {
  // Configure the active pane's dev server via the wrench (cmd + cwd, auto-saved on blur).
  await win.getByLabel("pane settings — project & dev server").click();
  const cmd = win.locator('input[placeholder="cmd (blank = auto-detect)"]');
  const cwd = win.locator('input[placeholder="project folder (cwd)"]');
  await cmd.waitFor({ timeout: 10_000 });
  // Each field auto-saves to the pane on *blur*, then refreshPanes re-syncs BOTH
  // inputs from the pane — so committing one field resets the other's input to the
  // pane value. Commit cwd first (its own blur), then cmd; the waits let React
  // re-render so each blur handler closes over the value just typed.
  await cwd.fill(FIXTURE);
  await win.waitForTimeout(250);
  await cwd.blur();
  await win.waitForTimeout(250);
  await cmd.fill("node server.mjs");
  await win.waitForTimeout(250);
  await cmd.blur();
  await win.waitForTimeout(250);
  await win.keyboard.press("Escape"); // close wrench
  await cmd.waitFor({ state: "hidden" }).catch(() => {});

  // Start it; the cockpit should auto-navigate the pane to the URL the server prints.
  await win.getByLabel("start / stop dev server").click();
  const ap = await waitForActive(win, (p) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(p.url || ""), 30_000);
  ctx.fixtureOrigin = ap?.url ? new URL(ap.url).origin : "";
  check("dev server auto-navigates the pane to its URL", !!ap, ap?.url ?? "(no localhost url)");

  // Page console output flows into the unified timeline (rendered in #list).
  await win.locator("#list .logrow", { hasText: "fixture: page loaded" }).first().waitFor({ timeout: 15_000 });
  check("page console logs land in the timeline", true);

  // Network is captured too — the 500 from /api/fail is always logged.
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

  // The "network" chip restricts to network rows (tag is `source:stream`).
  await win.locator(".chips .fchip", { hasText: "network" }).click();
  await win.waitForTimeout(250);
  const rows = await win.locator("#list .logrow").count();
  const allNetwork = await win.locator("#list .logrow .tag").evaluateAll((els) => els.length > 0 && els.every((e) => (e.textContent || "").includes("network")));
  check("network chip shows only network rows", rows >= 1 && allNetwork, `rows=${rows}`);
  await win.locator(".chips .fchip", { hasText: "network" }).click(); // toggle off
}

async function scenarioManualNavigation(_app: ElectronApplication, win: Page): Promise<void> {
  const target = `${ctx.fixtureOrigin}/api/ok`;
  const addr = win.locator(".browser-bar input.address");
  await addr.fill(target);
  await addr.press("Enter");
  const ap = await waitForActive(win, (p) => (p.url || "") === target, 15_000);
  check("address bar navigates the active pane", !!ap, ap?.url ?? target);
}

async function scenarioDevServerStop(_app: ElectronApplication, win: Page): Promise<void> {
  await win.getByLabel("start / stop dev server").click(); // toggles to stop
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
    // The dependable re-download path: install by id → chip appears.
    await extInput.fill(DARK_READER);
    await win.getByTitle("install from the pasted id / URL").click();
    await win.waitForSelector(`[data-testid="ext-chip-${DARK_READER}"]`, { timeout: 60_000 });
    check("ext install by id adds the chip", true);

    // Remove it → chip goes away AND it's unloaded from the panes session (regression
    // guard for the remove-hygiene fix).
    await win.locator(`[data-testid="ext-remove-${DARK_READER}"]`).click();
    await win.waitForSelector(`[data-testid="ext-chip-${DARK_READER}"]`, { state: "detached", timeout: 20_000 });
    const unloaded = await app.evaluate(({ session }, part) => !session.fromPartition(part).extensions.getExtension("eimadpbcbfnmbkopoojfekhnkhdbieeh"), PANE_PARTITION);
    check("ext remove unloads it from the session", unloaded);
  }
  await win.keyboard.press("Escape");
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
    await run("manual navigation", () => scenarioManualNavigation(app!, win));
    await run("dev server stop", () => scenarioDevServerStop(app!, win));
    await run("settings & extensions", () => scenarioSettingsAndExtensions(app!, win));

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
