/**
 * Network self-test steps: response-body capture + enriched NetDetail + HAR export
 * + clear-storage, device emulation + network throttling, and diagnose + bundle.
 */
import type { Check, SelftestCtx } from "./context.ts";

export async function networkSteps(ctx: SelftestCtx): Promise<Check[]> {
  const { manager, buffer, handleTool, shellWin, chosenPort, tick } = ctx;
  const tl = shellWin.webContents;

  tick("network + HAR + clear-storage");
  // 9) network body: fetch the cockpit's own HTTP server for a 404 (subresource → reliable body).
  await manager.navigate(`data:text/html,<script>fetch('http://localhost:${chosenPort}/nope').catch(()=>{})</script>`);
  await new Promise((r) => setTimeout(r, 800));
  const net = buffer
    .query({ source: "browser", stream: "network" })
    .find((e) => (e.detail as { status?: number })?.status === 404);
  const body = (net?.detail as { responseBody?: string } | undefined)?.responseBody;
  const bodyOk = typeof body === "string" && body.includes("not found");
  console.log(
    `SELFTEST network body: status=${(net?.detail as { status?: number })?.status} body=${JSON.stringify(body)}`,
  );

  // 9b) enriched network detail + HAR export.
  const nd = net?.detail as { requestHeaders?: unknown; responseHeaders?: unknown; durationMs?: number } | undefined;
  const har = JSON.parse((await handleTool("export_har", {})).content[0]!.text as string) as {
    log: { entries: { response?: { status?: number } }[] };
  };
  const harHas404 = har.log.entries.some((en) => en.response?.status === 404);
  const harOk = !!nd?.requestHeaders && !!nd?.responseHeaders && har.log.entries.length >= 1 && harHas404;
  console.log(
    `SELFTEST HAR: entries=${har.log.entries.length} 404=${harHas404} reqH=${!!nd?.requestHeaders} resH=${!!nd?.responseHeaders} ok=${harOk}`,
  );

  // 9c) clear storage: set localStorage on a real http origin, clear, verify it's gone.
  await manager.navigate(`http://localhost:${chosenPort}/devloop-clear-test`);
  await new Promise((r) => setTimeout(r, 300));
  await handleTool("browser_eval", { expression: "localStorage.setItem('__cs','yes')" });
  const csBefore = JSON.parse(
    (await handleTool("browser_eval", { expression: "localStorage.getItem('__cs')" })).content[0]!.text as string,
  ).value as string | null;
  await handleTool("browser_clear_storage", {});
  const csAfter = JSON.parse(
    (await handleTool("browser_eval", { expression: "localStorage.getItem('__cs')" })).content[0]!.text as string,
  ).value as string | null;
  const clearOk = csBefore === "yes" && csAfter === null;
  console.log(`SELFTEST clear-storage: before=${csBefore} after=${csAfter} ok=${clearOk}`);

  tick("emulate + throttle");
  // 9d) device emulation + network throttling.
  await manager.navigate('data:text/html,<meta name="viewport" content="width=device-width"><h1>vp</h1>');
  await handleTool("browser_emulate", { device: "iphone" });
  const ew = JSON.parse(
    (await handleTool("browser_eval", { expression: "String(innerWidth)" })).content[0]!.text as string,
  ).value as string;
  await handleTool("browser_emulate", { reset: true });
  // clearDeviceMetricsOverride is async — poll until the viewport actually resets
  // (reading too soon returns the stale emulated 390; was a recurring CI flake).
  let ew2 = "390";
  for (let i = 0; i < 15 && Number(ew2) <= 390; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ew2 = JSON.parse(
      (await handleTool("browser_eval", { expression: "String(innerWidth)" })).content[0]!.text as string,
    ).value as string;
  }
  const emuOk = ew === "390" && Number(ew2) > 390;
  await handleTool("browser_throttle", { profile: "offline" });
  const thOff = JSON.parse(
    (
      await handleTool("browser_eval", {
        expression: `fetch('http://localhost:${chosenPort}/x').then(()=>'ok').catch(()=>'fail')`,
      })
    ).content[0]!.text as string,
  ).value as string;
  await handleTool("browser_throttle", { profile: "none" });
  const thOn = JSON.parse(
    (
      await handleTool("browser_eval", {
        expression: `fetch('http://localhost:${chosenPort}/x').then(()=>'ok').catch(()=>'fail')`,
      })
    ).content[0]!.text as string,
  ).value as string;
  const emulateOk = emuOk && thOff === "fail" && thOn === "ok";
  console.log(`SELFTEST emulate/throttle: vp=${ew}→${ew2} offline=${thOff} none=${thOn} ok=${emulateOk}`);

  tick("diagnose + bundle");
  // 9e) diagnose: group duplicate errors + collect network failures.
  await handleTool("clear_logs", {});
  await manager.navigate(
    `data:text/html,<script>console.error('[boom] beta');console.error('[boom] beta');fetch('http://localhost:${chosenPort}/nope').catch(()=>{})</script>`,
  );
  await new Promise((r) => setTimeout(r, 700));
  const diag = JSON.parse((await handleTool("diagnose", {})).content[0]!.text as string) as {
    errorCount: number;
    groups: { count: number }[];
    network: { status?: number }[];
  };
  const diagnoseOk =
    diag.errorCount >= 2 && diag.groups.some((g) => g.count >= 2) && diag.network.some((n) => n.status === 404);
  console.log(
    `SELFTEST diagnose: errors=${diag.errorCount} dupGroup=${diag.groups.some((g) => g.count >= 2)} net404=${diag.network.some((n) => n.status === 404)} ok=${diagnoseOk}`,
  );

  // 9f) export_bundle: capture a screenshot, then assemble the bundle (logs + screenshot + har + diagnose).
  await tl.executeJavaScript("window.devloop.screenshot()");
  await new Promise((r) => setTimeout(r, 400));
  const bundle = JSON.parse((await handleTool("export_bundle", {})).content[0]!.text as string) as {
    meta: { counts: { logs: number; errors: number; screenshots: number } };
    diagnose: unknown;
    har: unknown;
    screenshots: unknown[];
    logs: unknown[];
  };
  const bundleOk =
    !!bundle.diagnose &&
    !!bundle.har &&
    bundle.screenshots.length >= 1 &&
    bundle.logs.length > 0 &&
    bundle.meta.counts.errors >= 2;
  console.log(
    `SELFTEST bundle: logs=${bundle.meta.counts.logs} screenshots=${bundle.screenshots.length} errors=${bundle.meta.counts.errors} ok=${bundleOk}`,
  );

  return [
    ["network response body", bodyOk],
    ["HAR export", harOk],
    ["clear storage", clearOk],
    ["device emulation + throttle", emulateOk],
    ["diagnose (group + network)", diagnoseOk],
    ["export bundle", bundleOk],
  ];
}
