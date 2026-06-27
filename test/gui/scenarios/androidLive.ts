/**
 * Live (not CI) cockpit check for the Android mirror — needs a booted emulator.
 * Drives the built app: openAndroid → frames flow into the renderer → tap issues →
 * closeAndroid. Run with: node test/gui/scenarios/androidLive.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, launchReady, results } from "../harness.ts";

const home = mkdtempSync(join(tmpdir(), "devloop-and-"));
const userData = mkdtempSync(join(tmpdir(), "devloop-and-ud-"));
const { app, win } = await launchReady(home, userData);
try {
  // Count frames as they arrive (set the listener up before opening).
  await win.evaluate(() => {
    (window as any).__frames = 0;
    (window as any).devloop.onAndroidFrame(() => (window as any).__frames++);
  });

  const env = await win.evaluate(() => (window as any).devloop.androidEnv());
  check("androidEnv ready (adb + booted device)", !!env?.ready, env?.summary);

  const open = await win.evaluate(() => (window as any).devloop.openAndroid());
  check("openAndroid ok", !!open?.ok, open?.serial ? `serial=${open.serial}` : open?.summary);

  await win.waitForTimeout(3000); // ~3s of screencap polling (~3fps)
  const frames = await win.evaluate(() => (window as any).__frames as number);
  check("mirror frames received in renderer", frames > 0, `${frames} frames`);

  // A tap through the bridge (coords in device px) must not throw.
  let tapOk = true;
  try {
    await win.evaluate(() => (window as any).devloop.androidTap(540, 1200));
  } catch {
    tapOk = false;
  }
  check("androidTap issues without error", tapOk);

  // #17 on Android: a fetch in the app's JS should become a network row via the
  // injected XHR interceptor (the same Hermes/CDP path as iOS — see reactNativeNet.ts).
  await win.evaluate(() =>
    (window as any).devloop.repro({
      action: {
        kind: "eval",
        expression: "fetch('https://example.com/').then(function(r){return r.text()}).catch(function(){})",
      },
      settleMs: 1500,
    }),
  );
  let netRow: { line?: string; detail?: { mimeType?: string; durationMs?: number } } | undefined;
  for (let i = 0; i < 12 && !netRow; i++) {
    const rows = (await win.evaluate(() => (window as any).devloop.getLogs({ stream: "network", limit: 50 }))) as {
      line?: string;
      detail?: { mimeType?: string; durationMs?: number };
    }[];
    netRow = rows.find((e) => e.line?.includes("example.com"));
    if (!netRow) await win.waitForTimeout(400);
  }
  check(
    "RN network request captured on Android (XHR interceptor)",
    !!netRow,
    netRow
      ? `${netRow.line} (${netRow.detail?.mimeType ?? "?"}, ${netRow.detail?.durationMs ?? "?"}ms)`
      : "no network row",
  );

  await win.evaluate(() => (window as any).devloop.closeAndroid());
  await app.close();
} finally {
  await app.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}

const failed = results().filter(([, ok]) => !ok);
console.log(failed.length ? `\nANDROID-GUI FAIL (${failed.length})` : `\nANDROID-GUI OK (${results().length} checks)`);
process.exit(failed.length ? 1 : 0);
