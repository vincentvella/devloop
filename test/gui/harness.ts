/**
 * Shared harness for the cockpit GUI suite — launches the built Electron app via
 * Playwright and gives scenarios a small toolkit for driving the renderer + reading
 * main-process state. See run.ts for the entry point and the bun→node note.
 */
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE = join(ROOT, "test", "fixtures", "web-app");
export const PANE_PARTITION = "persist:devloop-panes";
export const DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
export const RUN_EXT_E2E = process.env.GUI_EXT_E2E === "1"; // opt-in: hits the real Chrome Web Store (network)

export interface Pane {
  id: string;
  url: string;
  active: boolean;
  popped?: boolean;
  label?: string;
  dev?: { running?: boolean; cwd?: string };
}
interface Bridge {
  devloop: { panes(): Promise<Pane[]>; setDevConfig(c: { cmd: string; cwd: string }): Promise<unknown> };
}

const checks: Array<[string, boolean]> = [];
export function check(name: string, ok: boolean, detail = ""): void {
  checks.push([name, ok]);
  console.log(`GUI ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
export const results = (): ReadonlyArray<[string, boolean]> => checks;

/** Cross-scenario state (e.g. the fixture's URL, discovered once the dev server starts). */
export const ctx: { fixtureOrigin: string } = { fixtureOrigin: "" };

export const panes = (win: Page): Promise<Pane[]> => win.evaluate(() => (window as unknown as Bridge).devloop.panes());
export const activePane = async (win: Page): Promise<Pane | undefined> => (await panes(win)).find((p) => p.active);
export const tabCount = (win: Page): Promise<number> => win.locator(".tab:not(.add)").count();

// Poll the active pane from the node side. (Playwright's waitForFunction with an
// async predicate that calls the devloop IPC bridge resolves immediately — it
// treats the returned Promise as truthy without awaiting it per poll — so we
// drive the polling here instead.)
export async function waitForActive(win: Page, pred: (p: Pane) => boolean, timeoutMs = 30_000): Promise<Pane | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ap = await activePane(win);
    if (ap && pred(ap)) return ap;
    if (Date.now() >= end) return undefined;
    await win.waitForTimeout(300);
  }
}

/** Each scenario is isolated: a throw is recorded as a failed check, not an abort. */
export async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`${name} (threw)`, false, (e as Error).message.split("\n")[0]);
  }
}

/** Launch the built cockpit with an isolated registry + Chromium profile. */
export function launchApp(home: string, userData: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      "out/main.cjs",
      // --user-data-dir isolates this run's Chromium profile (no LevelDB lock
      // contention with a real Devloop instance; concurrent runs don't collide).
      `--user-data-dir=${userData}`,
      // On a headless CI runner the window is "occluded", so Chromium throttles the
      // renderer — the bridge/mount can stall for tens of seconds. Disable that so
      // the headed app comes up promptly (offscreen selftest isn't affected).
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
    cwd: ROOT,
    env: { ...process.env, DEVLOOP_HOME: home, DEVLOOP_HTTP_PORT: "0", ...extraEnv },
    timeout: 60_000,
  });
}

/** Launch and wait until the renderer is interactive (IPC bridge + shell mounted),
 *  relaunching if a cold start stalls — so a slow/occluded CI runner can't wedge the
 *  whole suite. Returns the app + its shell window. */
export async function launchReady(home: string, userData: string, extraEnv: Record<string, string> = {}, attempts = 3): Promise<{ app: ElectronApplication; win: Page }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const app = await launchApp(home, userData, extraEnv);
    try {
      const win = await app.firstWindow({ timeout: 30_000 });
      await win.waitForFunction(() => !!(window as { devloop?: unknown }).devloop, undefined, { timeout: 30_000 });
      await win.waitForSelector('[data-testid="pane-add"]', { timeout: 30_000 });
      return { app, win };
    } catch (e) {
      lastErr = e;
      await app.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/** Set the active pane's dev cmd + cwd via the wrench. Each field auto-saves on
 *  blur, then refreshPanes re-syncs both inputs from the pane — so committing one
 *  resets the other's input. We commit cmd then cwd (waits let React re-render so
 *  each blur handler closes over the value just typed), then verify it stuck and,
 *  if not, commit via the same IPC the inputs drive. The blur-save races under fast
 *  automation across panes; a human typing + tabbing doesn't hit it. */
export async function setDevConfig(win: Page, cmd: string, cwd: string): Promise<void> {
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
  if ((await activePane(win))?.dev?.cwd !== cwd) {
    await win.evaluate((c) => (window as unknown as Bridge).devloop.setDevConfig(c), { cmd, cwd });
    await win.waitForTimeout(300);
  }
}

export async function closeWrench(win: Page): Promise<void> {
  await win.keyboard.press("Escape");
  await win.locator('input[placeholder="cmd (blank = auto-detect)"]').waitFor({ state: "hidden" }).catch(() => {});
}
