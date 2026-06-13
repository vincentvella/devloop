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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LogBuffer } from "../src/logBuffer.ts";
import { ReactNativeController } from "../src/reactNativeController.ts";

const metroBase = process.argv[2] ?? "http://localhost:8082";
const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}`);
  if (!cond) fails.push(name);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const captureScreenshot = async () => {
  const p = join(tmpdir(), `devloop-rn-shot-${process.pid}.png`);
  execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", p]);
  return { base64: readFileSync(p).toString("base64"), mimeType: "image/png" };
};

const buffer = new LogBuffer(5000);
const rn = new ReactNativeController(buffer, { metroBase, captureScreenshot });

console.log(`# attaching to ${metroBase}`);
await rn.start();
await sleep(500);
check("attached to Hermes over CDP", buffer.query({}).some((e) => e.line.includes("attached to React Native")));

// evaluate round-trips
const sum = await rn.evaluate("1 + 2");
check("evaluate(1+2) → 3", sum === 3);

// console capture
await rn.evaluate("console.log('devloop-rn-harness hello', { ok: true })");
await sleep(400);
check("console.log captured", buffer.query({}).some((e) => e.stream === "console" && e.line.includes("devloop-rn-harness hello")));

// error via console.error (the RN path) → pageerror + source-mapped stack.
// Trigger it from BUNDLE code (Metro's global require __r on a bad id) so the
// stack has real entry.bundle frames to resolve — a `new Error()` made inside
// Runtime.evaluate would only have <eval> frames with nothing to map.
await rn.evaluate(
  "(function(){ try { (globalThis.__r || require)(999999999); } catch (e) { console.error(e); } })()",
);
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

await rn.close();
console.log(fails.length ? `\nRN-HARNESS FAIL (${fails.length}): ${fails.join(", ")}` : "\nRN-HARNESS OK (all checks passed)");
process.exit(fails.length ? 1 : 0);
