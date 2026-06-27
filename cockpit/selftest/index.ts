/**
 * Cockpit self-test orchestrator (run with DEVLOOP_SELFTEST=1; `bun run app:selftest`).
 *
 * Drives the real, fully-wired main process through the shared SelftestCtx and runs
 * the themed step suites in order under a per-step ratchet, then prints each check and
 * sets the exit code. Extracted from cockpit/main.ts so the app and its integration
 * test live in separate files.
 */
import type { Check, SelftestCtx } from "./context.ts";
import { coreSteps } from "./core.ts";
import { integrationSteps } from "./integration.ts";
import { interactionSteps } from "./interactions.ts";
import { networkSteps } from "./network.ts";
import { paneSteps } from "./panes.ts";

export type { SelftestCtx } from "./context.ts";

export async function runSelfTest(base: Omit<SelftestCtx, "tick">): Promise<void> {
  // Per-step ratchet: each step gets its own budget. tick(name) resets the timer; if a
  // step blows its budget the process exits naming that step (vs one global watchdog
  // that can't attribute the hang and shrinks every step's headroom as the suite grows).
  const STEP_BUDGET_MS = Number(process.env.DEVLOOP_SELFTEST_STEP_MS ?? 25_000);
  let currentStep = "boot";
  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  const tick = (name: string) => {
    currentStep = name;
    if (stepTimer) clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      base.log(`SELFTEST step "${currentStep}" exceeded ${STEP_BUDGET_MS}ms — exiting (hung step)`);
      base.app.exit(2);
    }, STEP_BUDGET_MS);
  };
  const ctx: SelftestCtx = { ...base, tick };

  const checks: Check[] = [];
  checks.push(...(await coreSteps(ctx)));
  checks.push(...(await paneSteps(ctx)));
  checks.push(...(await interactionSteps(ctx)));
  checks.push(...(await networkSteps(ctx)));
  checks.push(...(await integrationSteps(ctx)));

  if (stepTimer) clearTimeout(stepTimer); // suite finished — stop the per-step ratchet

  for (const [name, c] of checks) console.log(`  ${c ? "✓" : "✗"} ${name}`);
  const failed = checks.filter(([, c]) => !c).map(([n]) => n);
  if (failed.length) {
    console.log(`SELFTEST FAIL (${failed.length}): ${failed.join(", ")}`);
    base.app.exit(1); // non-zero so CI gates on it
    return;
  }
  console.log("SELFTEST OK");
  // Exit via the real user path — close the control window with panes still open.
  // This exercises pane-close → onChange teardown (regression: "Object has been destroyed").
  base.shellWin.close();
}
