/**
 * Live harness for the React Native controller (Phase 1, item 11). Drives the
 * real ReactNativeController against a running RN app in a booted iOS Simulator
 * — the CI suites can't (no simulator), so this is the local validation.
 *
 * Prereqs: a booted sim with the app loaded + its Metro running. Then:
 *   bun run scripts/rn-harness.ts http://localhost:8082
 *
 * Named ✓/✗ checks with a real exit code, same style as test-smoke.ts.
 */
import { execFile } from "node:child_process";
import { AndroidLogStream, adbBinary, captureAdbScreenshot } from "../src/androidLog.ts";
import { captureSimctlScreenshot, NativeLogStream } from "../src/iosSimulator.ts";
import { LogBuffer } from "../src/logBuffer.ts";
import { adbDriver, idbDriver } from "../src/nativeDriver.ts";
import { ReactNativeController } from "../src/reactNativeController.ts";

// usage: rn-harness.ts <metroBase> <appMatch> [ios|android] [device|serial]
const metroBase = process.argv[2] ?? "http://localhost:8082";
const appMatch = process.argv[3] ?? "Caliburr"; // native log scoping (process name)
const platform = (process.argv[4] as "ios" | "android") || "ios";
const isAndroid = platform === "android";
const device = process.argv[5] ?? (isAndroid ? "any" : "booted");
const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}`);
  if (!cond) fails.push(name);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// idb runner (iOS) for the interaction/snapshot path (needs idb on PATH).
const runIdb = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile("idb", args, { maxBuffer: 16 * 1024 * 1024 }, (e, out, errOut) =>
      e ? reject(new Error(errOut || (e as Error).message)) : resolve(out),
    ),
  );
// adb runner (Android).
const runAdb = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(adbBinary(), args, { maxBuffer: 16 * 1024 * 1024 }, (e, out, errOut) =>
      e ? reject(new Error(errOut || (e as Error).message)) : resolve(out),
    ),
  );

const buffer = new LogBuffer(5000);
const driver = isAndroid ? adbDriver(device, runAdb) : idbDriver(device, runIdb);
const captureScreenshot = () => (isAndroid ? captureAdbScreenshot(device) : captureSimctlScreenshot(device));
const rn = new ReactNativeController(buffer, { metroBase, driver, captureScreenshot });

// Native device logs (simctl on iOS, logcat on Android) — runs alongside the JS console.
const nativeLogs = isAndroid
  ? new AndroidLogStream(buffer, { serial: device })
  : new NativeLogStream(buffer, { device, match: appMatch });
nativeLogs.start();

console.log(
  `# attaching to ${metroBase} (${platform}, native logs ${isAndroid ? "via logcat" : `scoped to "${appMatch}"`})`,
);
await rn.start();
await sleep(500);
check(
  "attached to Hermes over CDP",
  buffer.query({}).some((e) => e.line.includes("attached to React Native")),
);

// evaluate round-trips
const sum = await rn.evaluate("1 + 2");
check("evaluate(1+2) → 3", sum === 3);

// console capture
await rn.evaluate("console.log('devloop-rn-harness hello', { ok: true })");
await sleep(400);
check(
  "console.log captured",
  buffer.query({}).some((e) => e.stream === "console" && e.line.includes("devloop-rn-harness hello")),
);

// #17 network capture: the injected XHR interceptor should turn a fetch into a network row.
await rn.evaluate("fetch('https://example.com/').then(function(r){return r.text()}).catch(function(){})");
let netEntry: ReturnType<typeof buffer.query>[number] | undefined;
for (let i = 0; i < 10; i++) {
  await sleep(500);
  netEntry = buffer.query({ stream: "network" }).find((e) => e.line.includes("example.com"));
  if (netEntry) break;
}
check("RN network request captured (XHR interceptor)", !!netEntry);
if (netEntry)
  console.log(
    `    network row: ${netEntry.line} (${(netEntry.detail as any)?.mimeType ?? "?"}, ${(netEntry.detail as any)?.durationMs ?? "?"}ms)`,
  );

// error via console.error (the RN path) → pageerror + source-mapped stack.
// Trigger it from BUNDLE code (Metro's global require __r on a bad id) so the
// stack has real entry.bundle frames to resolve — a `new Error()` made inside
// Runtime.evaluate would only have <eval> frames with nothing to map.
await rn.evaluate("(function(){ try { (globalThis.__r || require)(999999999); } catch (e) { console.error(e); } })()");
let err: (typeof buffer.query extends (...a: any) => infer R ? R : never)[number] | undefined;
for (let i = 0; i < 12; i++) {
  await sleep(600); // async source-map fetch/resolve (Metro bundle + map are large)
  err = buffer.query({}).find((e) => e.stream === "pageerror" && /unknown module|999999999/i.test(e.line));
  if ((err?.detail as any)?.resolvedStack?.length) break;
}
check("bundle error surfaced as pageerror", !!err);
const resolved = (err?.detail as any)?.resolvedStack as { source?: string }[] | undefined;
check("pageerror stack resolved to original source", !!resolved?.length);
if (resolved?.length) console.log(`    resolved top frame → ${resolved[0]?.source}`);

// screenshot via simctl
const shot = await rn.screenshot();
check("screenshot captured (PNG base64)", shot.base64.length > 1000 && shot.mimeType === "image/png");

// Phase 2 (idb): a11y snapshot — read-only, so it's safe to run here. Skips cleanly
// if idb isn't installed. Interactions (tap/type/scroll/press) use the same path.
try {
  const snap = await rn.snapshot();
  check("idb snapshot returns a11y nodes", snap.nodes.length > 0);
  console.log(
    `    snapshot nodes: ${snap.nodes.length}${snap.nodes[0] ? ` (e.g. ${snap.nodes[0].role} "${snap.nodes[0].name}" @ ${snap.nodes[0].ref})` : ""}`,
  );
} catch (e) {
  console.log(`    (idb snapshot skipped: ${(e as Error).message.split(":").pop()?.trim()})`);
}

// native device logs (simctl) on the same timeline
await sleep(2500);
const nativeCount = buffer.query({ source: "native" }).length;
check("native device logs captured (simctl)", nativeCount > 0);
console.log(`    native entries: ${nativeCount}`);
nativeLogs.stop();

// Clean up: our bundle-error trigger raises an on-device LogBox overlay. Dismiss
// it so the harness doesn't leave a red screen on the app.
await rn.evaluate(
  "(()=>{try{const m=require('react-native/Libraries/LogBox/Data/LogBoxData');(m.clear||m.default.clear)();return 'cleared';}catch(e){return String(e);}})()",
);
await sleep(300);

await rn.close();
console.log(
  fails.length ? `\nRN-HARNESS FAIL (${fails.length}): ${fails.join(", ")}` : "\nRN-HARNESS OK (all checks passed)",
);
process.exit(fails.length ? 1 : 0);
