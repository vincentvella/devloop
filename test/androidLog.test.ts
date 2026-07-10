import { expect, test } from "bun:test";
import { AndroidLogStream, adbBinary } from "../src/androidLog.ts";
import type { NativeLogLine } from "../src/iosSimulator.ts";

test("adbBinary prefers a real SDK platform-tools path, else falls back to PATH", () => {
  // No SDK roots set + bogus home → falls back to bare "adb".
  expect(adbBinary({ ANDROID_HOME: "/nope", ANDROID_SDK_ROOT: "/nope2", HOME: "/nonexistent-home" } as any)).toBe(
    "adb",
  );
});

test("AndroidLogStream parses spawned logcat into log lines", () => {
  let spawnedArgs: string[] = [];
  const lines: NativeLogLine[] = [];
  const stream = new AndroidLogStream({
    serial: "emulator-5554",
    onLine: (l) => lines.push(l),
    spawn: (_cmd, args) => {
      spawnedArgs = args;
      return { stdout: null, kill() {} };
    },
  });
  stream.start();
  expect(spawnedArgs).toContain("logcat");
  expect(spawnedArgs).toContain("-s");

  // Feed two lines split across chunks; a banner is dropped.
  stream.onData("E/AndroidRuntime( 12): boom\n--------- beginning of main\nI/ReactNativeJS( 3): hel");
  stream.onData("lo\n");
  expect(lines.map((l) => l.message)).toEqual(["boom", "hello"]);
  expect(lines.map((l) => l.level)).toEqual(["error", "info"]);
  expect(lines[0]?.pid).toBe(12);
});
