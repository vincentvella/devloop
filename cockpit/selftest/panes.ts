/**
 * Pane self-test steps: multi-target panes + pop-out/re-dock + persistence, the
 * repro builder (via the React test hook), and the dev server through the UI path
 * (auto-navigate, per-pane log tagging, app-scoped get_logs).
 */
import type { Check, SelftestCtx } from "./context.ts";

export async function paneSteps(ctx: SelftestCtx): Promise<Check[]> {
  const { manager, buffer, handleTool, shellWin, getPanes, tick } = ctx;
  const tl = shellWin.webContents;

  tick("multi-pane + pop-out");
  // 6) multi-target: open a 2nd pane, navigate it, assert events are tagged per-pane
  const pane2 = JSON.parse((await handleTool("pane_new", { url: "about:blank" })).content[0]!.text as string);
  await manager.navigate("data:text/html,<script>console.log('in-pane-2')</script>"); // active = pane2
  await new Promise((r) => setTimeout(r, 300));
  const paneList = JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
    panes: { id: string }[];
  };
  const p2Event = buffer.query({}).find((e) => e.line.includes("in-pane-2"));
  const taggedRight = p2Event?.target === pane2.id;
  console.log(
    `SELFTEST panes: count=${paneList.panes.length} pane2=${pane2.id} eventTarget=${p2Event?.target} tagged=${taggedRight}`,
  );

  // 6a) persistence: the open panes should be saved (for restore on relaunch)
  const persistedCount = getPanes().panes.length;
  const persistOk = persistedCount >= 2;
  console.log(`SELFTEST persisted panes: ${persistedCount}`);

  // 6b) pop-out: detach pane-2 into its own window; pane_list should flag it popped
  await handleTool("pane_pop", { id: pane2.id });
  const afterPop = JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
    panes: { id: string; popped?: boolean }[];
  };
  const poppedInfo = afterPop.panes.find((p) => p.id === pane2.id) as
    | { popped?: boolean; active?: boolean }
    | undefined;
  // Popped pane stays ACTIVE so its config/controls persist (regression: gear cleared on pop-out).
  const popOk = poppedInfo?.popped === true && poppedInfo?.active === true;
  console.log(`SELFTEST pop-out: ${pane2.id} popped=${poppedInfo?.popped} stillActive=${poppedInfo?.active}`);

  // 6c) closing the pop-out window re-docks the pane (doesn't destroy it).
  manager.__closePoppedWindow(pane2.id);
  await new Promise((r) => setTimeout(r, 200));
  const afterDock = JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
    panes: { id: string; popped?: boolean }[];
  };
  const dockedPane = afterDock.panes.find((p) => p.id === pane2.id);
  const redockOk = !!dockedPane && dockedPane.popped !== true; // still exists, no longer popped
  console.log(`SELFTEST re-dock: pane present=${!!dockedPane} popped=${dockedPane?.popped ?? false} ok=${redockOk}`);

  tick("repro builder");
  // 7) repro builder: run via the React test hook, confirm inline render + session persistence
  const builder = (await tl.executeJavaScript(`(async () => {
    await window.__devloopTest.runRepro([{ kind: 'navigate', url: 'data:text/html,<title>x</title>' }]);
    await new Promise(r=>setTimeout(r,1500));
    const listText = document.getElementById('list').textContent || '';
    const sess = await window.devloop.session();
    return JSON.stringify({ inlineRendered: listText.includes('▶ repro'), sessionSteps: (sess.steps||[]).length });
  })()`)) as string;
  console.log(`SELFTEST repro builder -> ${builder}`);
  const b = JSON.parse(builder);
  const builderOk = b.inlineRendered === true && b.sessionSteps >= 1;

  tick("dev server (UI) + per-pane");
  // 8) dev server via the UI path (sets awaitingDevUrl): a server that prints a localhost URL
  //    must trigger auto-navigate, and the sleep 6017 group must die on quit.
  const devArgs = JSON.stringify({
    cmd: 'bash -c "echo Local: http://localhost:4599; sleep 6017"',
    cwd: process.cwd(),
  });
  await tl.executeJavaScript(`window.devloop.devStart(${devArgs})`);
  await new Promise((r) => setTimeout(r, 1000));
  const devName = JSON.parse((await handleTool("dev_status")).content[0]!.text as string).name;
  console.log(`SELFTEST dev started via UI (auto-nav to :4599); project name=${devName}`);
  const nameOk = devName === "devloop-mcp"; // package.json name of this repo

  // 8b) per-pane: the dev server's logs are tagged with the active pane; reload IPC works.
  const activeId = (
    JSON.parse((await handleTool("pane_list")).content[0]!.text as string) as {
      panes: { id: string; active: boolean }[];
    }
  ).panes.find((p) => p.active)!.id;
  const serverTagged = buffer.query({ source: "server" }).some((e) => e.target === activeId);
  await tl.executeJavaScript("window.devloop.reload(false)");
  await tl.executeJavaScript("window.devloop.reload(true)");
  console.log(`SELFTEST per-pane: activePane=${activeId} serverLogTagged=${serverTagged}`);
  const perPaneOk = serverTagged;

  // 8c) app-scoped logs: get_logs({ app }) returns only that pane's entries.
  const scoped = JSON.parse(
    (await handleTool("get_logs", { app: activeId, limit: 500 })).content[0]!.text as string,
  ) as {
    entries: { target?: string }[];
  };
  const appScopeOk = scoped.entries.length > 0 && scoped.entries.every((e) => e.target === activeId);
  console.log(`SELFTEST app-scope: app=${activeId} entries=${scoped.entries.length} allTagged=${appScopeOk}`);

  return [
    ["multiple panes", paneList.panes.length >= 2],
    ["per-pane event tagging", taggedRight],
    ["pop-out", popOk],
    ["re-dock", redockOk],
    ["repro builder inline render", builderOk],
    ["derived project name", nameOk],
    ["pane persistence", persistOk],
    ["per-pane dev server-log tagging", perPaneOk],
    ["app-scoped get_logs", appScopeOk],
  ];
}
