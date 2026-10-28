/**
 * Live (not CI) cockpit check for the Android screen — needs a booted emulator.
 * Drives the built app like a user: point the pane at the native fixture, pick the
 * Android target, and wait for serve-emu's H.264 stream to paint in the renderer's
 * DeviceScreen. Then closes Android and checks scrcpy stopped on the device.
 * Run with: bun run android:smoke
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { check, closeWrench, launchReady, NATIVE_FIXTURE, results, setDevConfig } from "../harness.ts";

/** adb from the SDK (this runs under plain node, so it can't import src/androidLog.ts). */
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), "Library", "Android", "sdk");
const adbBinary = (): string =>
  existsSync(join(sdk, "platform-tools", "adb")) ? join(sdk, "platform-tools", "adb") : "adb";

/** scrcpy server processes on the device (serve-emu starts one per stream). */
const scrcpyOnDevice = (): number => {
  try {
    const ps = execFileSync(adbBinary(), ["shell", "ps", "-A", "-o", "ARGS"], { encoding: "utf8" });
    return ps.split("\n").filter((l) => l.includes("com.genymobile.scrcpy")).length;
  } catch {
    return -1;
  }
};

const home = mkdtempSync(join(tmpdir(), "devloop-and-"));
const userData = mkdtempSync(join(tmpdir(), "devloop-and-ud-"));
const { app, win } = await launchReady(home, userData);
try {
  const env = await win.evaluate(() => (window as any).devloop.androidEnv());
  check("androidEnv ready (adb + booted device)", !!env?.ready, env?.summary);

  // A native pane, then the Android target (switchTarget → openAndroid → stream endpoint).
  await setDevConfig(win, "", NATIVE_FIXTURE);
  await closeWrench(win);
  const sw = win.locator(".target-switch");
  await sw.waitFor({ timeout: 20_000 });
  await sw.locator("button.seg", { hasText: "Android" }).click();

  const stage = win.locator('.android-stage[data-status="streaming"]');
  const t0 = Date.now();
  const streaming = await stage
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check("DeviceScreen reaches `streaming`", streaming, streaming ? `${Date.now() - t0}ms` : "timed out");

  // Real frames painted: sample the stage's pixels from a main-process capture.
  await win.waitForTimeout(1500);
  const box = await stage.boundingBox();
  const painted = box
    ? await app.evaluate(
        async ({ BrowserWindow }, rect) => {
          const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(rect);
          const { width, height } = img.getSize();
          const px = img.toBitmap();
          const colours = new Set<number>();
          let lit = 0;
          let n = 0;
          for (let y = 0; y < height; y += 4)
            for (let x = 0; x < width; x += 4) {
              const i = (y * width + x) * 4;
              const [b, g, r] = [px[i]!, px[i + 1]!, px[i + 2]!];
              n++;
              if (r + g + b > 60) lit++;
              colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
            }
          return { colours: colours.size, litPct: Math.round((100 * lit) / Math.max(n, 1)) };
        },
        { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      )
    : null;
  check(
    "device frames painted in the cockpit",
    !!painted && painted.colours > 20 && painted.litPct > 2,
    painted ? `${painted.colours} colours, ${painted.litPct}% lit` : "no stage",
  );
  check("scrcpy is running on the device while streaming", scrcpyOnDevice() > 0);
  if (process.env.ANDROID_SMOKE_SHOT) await win.screenshot({ path: process.env.ANDROID_SMOKE_SHOT });

  // #17 on Android: opt-in (ANDROID_SMOKE_RN=1), since it runs a fetch inside whatever
  // React Native app Metro (:8081) has attached — possibly one you're working in.
  if (process.env.ANDROID_SMOKE_RN === "1") {
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
  }

  await win.evaluate(() => (window as any).devloop.closeAndroid());
  await win.waitForTimeout(1500);
  check("closing Android stops scrcpy on the device", scrcpyOnDevice() === 0, `${scrcpyOnDevice()} left`);
  await app.close();
} finally {
  await app.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}

const failed = results().filter(([, ok]) => !ok);
console.log(failed.length ? `\nANDROID-GUI FAIL (${failed.length})` : `\nANDROID-GUI OK (${results().length} checks)`);
process.exit(failed.length ? 1 : 0);
