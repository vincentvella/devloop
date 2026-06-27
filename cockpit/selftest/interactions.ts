/**
 * Interaction self-test steps: browser_snapshot + browser_wait_for (+ a repro
 * 'wait' step), richer interactions (select/press/hover), and the element picker.
 */
import type { Check, SelftestCtx } from "./context.ts";

export async function interactionSteps(ctx: SelftestCtx): Promise<Check[]> {
  const { manager, handleTool, tick } = ctx;

  tick("snapshot + interactions + picker");
  // 8d) browser_snapshot + browser_wait_for (+ a repro 'wait' step).
  await manager.navigate(
    "data:text/html,<h1>snap</h1><label for=q>Find</label><input id=q><button id=b aria-label='Tap'>x</button>",
  );
  const waitRes = JSON.parse(
    (await handleTool("browser_wait_for", { selector: "#b", timeoutMs: 3000 })).content[0]!.text as string,
  ) as { ok: boolean };
  const snap = JSON.parse((await handleTool("browser_snapshot")).content[0]!.text as string) as {
    nodes: { ref: string; role: string; name: string }[];
  };
  const hasBtn = snap.nodes.some((n) => n.ref === "#b" && n.role === "button" && n.name === "Tap");
  const hasInput = snap.nodes.some((n) => n.ref === "#q" && n.role === "textbox" && n.name === "Find");
  const reproWait = JSON.parse(
    (
      await handleTool("repro", {
        action: { kind: "wait", selector: "#b", timeoutMs: 3000 },
        waitFor: "settle",
        settleMs: 200,
      })
    ).content[0]!.text as string,
  ) as { stepCount: number };
  const snapshotOk = waitRes.ok && hasBtn && hasInput && reproWait.stepCount === 1;
  console.log(
    `SELFTEST snapshot: nodes=${snap.nodes.length} waitOk=${waitRes.ok} btn=${hasBtn} input=${hasInput} reproWait=${reproWait.stepCount} ok=${snapshotOk}`,
  );

  // 8e) richer interactions: select / press / hover. Hardened against a timing
  // race that flaked in CI: the data: navigation can resolve before the DOM is
  // interactive, so an action would occasionally no-op. We (1) wait for the doc to
  // be ready, then (2) re-issue the (idempotent) actions and re-read until they
  // stick — each action just re-sets the same state, so retrying is safe. Bounded
  // well under the per-step ratchet; breaks immediately on the common happy path.
  await manager.navigate(
    `data:text/html,<select id=s><option value=a>A</option><option value=b>B</option></select><input id=t onkeydown="if(event.key==='Enter')window.__p=1"><button id=h onmouseover="window.__h=1">h</button>`,
  );
  await handleTool("browser_wait_for", { selector: "#s", timeoutMs: 5000 });
  let ixv = { sel: "", p: false, h: false };
  for (let attempt = 0; attempt < 20; attempt++) {
    await handleTool("browser_select", { selector: "#s", value: "b" });
    await handleTool("browser_press", { key: "Enter", selector: "#t" });
    await handleTool("browser_hover", { selector: "#h" });
    ixv = JSON.parse(
      JSON.parse(
        (
          await handleTool("browser_eval", {
            expression: "JSON.stringify({sel:document.getElementById('s').value,p:!!window.__p,h:!!window.__h})",
          })
        ).content[0]!.text as string,
      ).value as string,
    ) as { sel: string; p: boolean; h: boolean };
    if (ixv.sel === "b" && ixv.p && ixv.h) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ixOk = ixv.sel === "b" && ixv.p && ixv.h;
  console.log(`SELFTEST interactions: select=${ixv.sel === "b"} press=${ixv.p} hover=${ixv.h} ok=${ixOk}`);

  // 8f) element picker: pick() resolves the selector of the element the user clicks.
  await manager.navigate("data:text/html,<button id=pk>pick me</button>");
  const pickPromise = manager.pick();
  await new Promise((r) => setTimeout(r, 300)); // let the picker install its listeners
  await manager.click("#pk"); // a real click resolves the picker
  const picked = await pickPromise;
  const pickOk = picked === "#pk";
  console.log(`SELFTEST picker: picked=${picked} ok=${pickOk}`);

  return [
    ["browser_snapshot + wait_for", snapshotOk],
    ["interactions (select/press/hover)", ixOk],
    ["element picker", pickOk],
  ];
}
