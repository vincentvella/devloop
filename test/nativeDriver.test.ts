import { expect, test } from "bun:test";
import { idbDriver, adbDriver } from "../src/nativeDriver.ts";

// Capture the args each driver hands to its injected runner, and feed back canned stdout.
function recorder(stdout = "") {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return stdout;
  };
  return { calls, run };
}

test("adbDriver maps actions to adb args + parses uiautomator", async () => {
  const xml = `<hierarchy><node text="Go" class="android.widget.Button" clickable="true" bounds="[0,0][100,100]"/></hierarchy>`;
  const { calls, run } = recorder(xml);
  const d = adbDriver("emulator-5554", run);
  expect(d.platform).toBe("android");

  const snap = await d.snapshot("Caliburr");
  expect(snap.nodes[0]).toMatchObject({ ref: "pt:50,50", role: "Button", name: "Go" });
  expect(calls.at(-1)).toEqual(["-s", "emulator-5554", "exec-out", "uiautomator", "dump", "/dev/tty"]);

  await d.tap(10, 20);
  expect(calls.at(-1)).toEqual(["-s", "emulator-5554", "shell", "input", "tap", "10", "20"]);
  await d.type("hi there");
  expect(calls.at(-1)).toEqual(["-s", "emulator-5554", "shell", "input", "text", "hi%sthere"]);
  await d.swipe(1, 2, 3, 4, 250);
  expect(calls.at(-1)).toEqual(["-s", "emulator-5554", "shell", "input", "swipe", "1", "2", "3", "4", "250"]);

  expect(await d.key("Enter")).toBe(true);
  expect(calls.at(-1)).toEqual(["-s", "emulator-5554", "shell", "input", "keyevent", "66"]);
  expect(await d.key("F13")).toBe(false); // unmapped → false, no extra call
});

test("idbDriver maps actions to idb args", async () => {
  const { calls, run } = recorder("[]");
  const d = idbDriver("UDID", run);
  expect(d.platform).toBe("ios");
  await d.tap(5, 6);
  expect(calls.at(-1)).toContain("UDID");
  expect(calls.at(-1)).toContain("tap");
  expect(await d.key("Enter")).toBe(true);
  expect(await d.key("F13")).toBe(false);
});
