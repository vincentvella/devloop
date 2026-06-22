/**
 * GUI suite entry — end-to-end test of the cockpit's *renderer* through the real DOM.
 *
 * app:selftest exercises the tool layer + IPC handlers programmatically; it never
 * clicks the actual UI, which is how the extension-list remove bug slipped past it.
 * This suite launches the built Electron app via Playwright and drives the shell
 * renderer like a user — clicking buttons, reading rendered state — plus reaches
 * into the main process to assert side effects. Run after a build.
 *
 *   bun run app:gui                 # build + drive
 *   GUI_EXT_E2E=1 bun run app:gui   # also run the (networked) Web Store install/toggle/remove flow
 *
 * macOS/Windows: launches a real window. Linux/CI: wrap in xvfb-run.
 * Exits non-zero if any check fails.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

// Playwright's Electron control channel (the Node-inspector handshake it uses to
// drive the main process) hangs under bun's runtime — even though bun's WebSocket
// client is otherwise fine for plain ws and Chromium's CDP. Rather than patch
// Playwright's bundled internals (fragile across upgrades), transparently re-exec
// under node when launched under bun. So `bun test/gui/run.ts`, `node test/gui/run.ts`,
// and `bun run app:gui` all work. (Imports below are side-effect-free until main().)
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  const r = spawnSync("node", [SELF, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { check, launchApp, results, run } = await import("./harness.ts");
const { shellAndPanes, multiPane, popOut } = await import("./scenarios/panes.ts");
const { devServerAndLogs, devServerStop } = await import("./scenarios/devServer.ts");
const { logsFilter, screenshot, repro, manualNavigation, exports } = await import("./scenarios/timeline.ts");
const { projectRegistry, settingsAndExtensions, storeInjectedButton } = await import("./scenarios/settings.ts");
const { updateFeedback } = await import("./scenarios/updates.ts");
const { persistence } = await import("./scenarios/persistence.ts");

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "devloop-gui-"));
  const userData = mkdtempSync(join(tmpdir(), "devloop-gui-ud-"));
  // NET_THRESHOLD=0 captures all network events so the timeline assertions are deterministic.
  let app: Awaited<ReturnType<typeof launchApp>> | undefined = await launchApp(home, userData, { DEVLOOP_NET_THRESHOLD: "0" });
  try {
    if (process.env.GUI_DEBUG) app.process().stderr?.on("data", (d: Buffer) => process.stderr.write(`[elec] ${d}`));
    const win = await app.firstWindow();
    check("main process is Devloop", (await app.evaluate(({ app }) => app.getName())) === "Devloop");

    const a = app;
    await run("shell & panes", () => shellAndPanes(a, win));
    await run("dev server & logs", () => devServerAndLogs(a, win));
    await run("logs filter", () => logsFilter(a, win));
    await run("screenshot", () => screenshot(a, win));
    await run("repro builder", () => repro(a, win));
    await run("manual navigation", () => manualNavigation(a, win));
    await run("exports", () => exports(a, win));
    await run("project registry", () => projectRegistry(a, win));
    await run("multi-pane", () => multiPane(a, win));
    await run("pop-out", () => popOut(a, win));
    await run("dev server stop", () => devServerStop(a, win));
    await run("settings & extensions", () => settingsAndExtensions(a, win));
    await run("store injected button", () => storeInjectedButton(a, win));
    await run("update feedback", () => updateFeedback(a, win));

    await app.close();
    app = undefined;
  } finally {
    if (app) await app.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }

  await run("persistence/restore", () => persistence());
}

main()
  .then(() => {
    const failed = results().filter(([, ok]) => !ok);
    if (failed.length) {
      console.log(`\nGUI DRIVE FAIL (${failed.length}/${results().length}): ${failed.map(([n]) => n).join(", ")}`);
      process.exit(1);
    }
    console.log(`\nGUI DRIVE OK (${results().length} checks)`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("GUI DRIVE ERROR:", e);
    process.exit(1);
  });
