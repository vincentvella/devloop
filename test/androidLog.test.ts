import { expect, test } from "bun:test";
import { AndroidLogStream, adbBinary } from "../src/androidLog.ts";
import { LogBuffer } from "../src/logBuffer.ts";

test("adbBinary prefers a real SDK platform-tools path, else falls back to PATH", () => {
  // No SDK roots set + bogus home → falls back to bare "adb".
  expect(adbBinary({ ANDROID_HOME: "/nope", ANDROID_SDK_ROOT: "/nope2", HOME: "/nonexistent-home" } as any)).toBe("adb");
});

test("AndroidLogStream parses spawned logcat into native buffer entries", () => {
  const buffer = new LogBuffer(100);
  let spawnedArgs: string[] = [];
  const stream = new AndroidLogStream(buffer, {
    serial: "emulator-5554",
    target: "pane1",
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
  const entries = buffer.query({ source: "native" });
  expect(entries.map((e) => e.line)).toEqual(["boom", "hello"]);
  expect(entries.map((e) => e.stream)).toEqual(["error", "info"]);
});
