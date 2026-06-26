import { expect, test } from "bun:test";
import { LogBuffer } from "../src/logBuffer.ts";
import { computeFingerprint, fingerprintNodeArgs, runNativeBuild } from "../src/nativeBuildRunner.ts";

test("fingerprintNodeArgs uses the project's own @expo/fingerprint via env root", () => {
  const [flag, script] = fingerprintNodeArgs();
  expect(flag).toBe("-e");
  expect(script).toContain("@expo/fingerprint");
  expect(script).toContain("createFingerprintAsync");
  expect(script).toContain("DL_FP_ROOT"); // root passed via env, not interpolated
});

test("computeFingerprint trims hash output and is null-safe", async () => {
  expect(await computeFingerprint("/proj", async () => "  deadbeef\n")).toBe("deadbeef");
  expect(await computeFingerprint("/proj", async () => "")).toBeNull();
  expect(
    await computeFingerprint("/proj", async () => {
      throw new Error("no @expo/fingerprint");
    }),
  ).toBeNull();
});

// Minimal ChildProcess-like fake for the spawn seam.
function fakeProc() {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const streamHandlers: ((c: string) => void)[] = [];
  return {
    proc: {
      stdout: { on: (_e: string, cb: (c: string) => void) => streamHandlers.push(cb) },
      stderr: { on: () => {} },
      on: (e: string, cb: (arg?: unknown) => void) => {
        handlers[e] ??= [];
        handlers[e].push(cb);
      },
      kill: () => {},
    },
    emitStdout: (s: string) => {
      for (const h of streamHandlers) h(s);
    },
    exit: (code: number | null) => {
      for (const h of handlers.exit ?? []) h(code);
    },
  };
}

test("runNativeBuild streams output to the timeline and reports failure", async () => {
  const buffer = new LogBuffer(100);
  const f = fakeProc();
  const handle = runNativeBuild({
    buffer,
    projectRoot: "/proj",
    platform: "ios",
    spawnImpl: (() => f.proc) as never,
  });

  f.emitStdout("Planning build\nCompiling Caliburr\n");
  f.emitStdout("Lin"); // partial line buffered until newline
  f.emitStdout("king\n");
  f.exit(1);
  const result = await handle.done;

  const lines = buffer.query({ source: "server" }).map((e) => e.line);
  expect(lines[0]).toContain("building ios: bunx expo run:ios");
  expect(lines).toContain("Planning build");
  expect(lines).toContain("Compiling Caliburr");
  expect(lines).toContain("Linking"); // chunk-split line reassembled
  expect(lines.at(-1)).toContain("build failed (exit 1)");
  expect(result.ok).toBe(false);
});
