import { expect, test } from "bun:test";
import { adbTapArgs, adbTextArgs, adbSwipeArgs, adbKeyeventArgs, adbUiDumpArgs, adbScreencapArgs, adbLogcatArgs, androidKeycodeFor, parseUiAutomatorDump, parseLogcatLine, androidErrorLevel, parseAdbDevices, usableSerials, parseWmSize } from "../src/adb.ts";

const S = "emulator-5554";

test("adb arg builders (serial-scoped; 'any' drops -s)", () => {
  expect(adbTapArgs(S, 100.6, 200)).toEqual(["-s", S, "shell", "input", "tap", "101", "200"]);
  expect(adbTextArgs(S, "hello world")).toEqual(["-s", S, "shell", "input", "text", "hello%sworld"]);
  expect(adbSwipeArgs(S, 200, 600, 200, 200)).toEqual(["-s", S, "shell", "input", "swipe", "200", "600", "200", "200"]);
  expect(adbSwipeArgs(S, 200, 600, 200, 200, 300)).toEqual(["-s", S, "shell", "input", "swipe", "200", "600", "200", "200", "300"]);
  expect(adbKeyeventArgs(S, 66)).toEqual(["-s", S, "shell", "input", "keyevent", "66"]);
  expect(adbUiDumpArgs(S)).toEqual(["-s", S, "exec-out", "uiautomator", "dump", "/dev/tty"]);
  expect(adbScreencapArgs(S)).toEqual(["-s", S, "exec-out", "screencap", "-p"]);
  expect(adbTapArgs("any", 1, 2)).toEqual(["shell", "input", "tap", "1", "2"]); // no -s
});

test("androidKeycodeFor maps the press keys, null otherwise", () => {
  expect(androidKeycodeFor("Enter")).toBe(66);
  expect(androidKeycodeFor("Backspace")).toBe(67);
  expect(androidKeycodeFor("ArrowDown")).toBe(20);
  expect(androidKeycodeFor("Back")).toBe(4);
  expect(androidKeycodeFor("F13")).toBeNull();
});

test("parseUiAutomatorDump builds a snapshot with center-point refs", () => {
  const xml = `<?xml version='1.0'?><hierarchy rotation="0">
    <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2280]">
      <node text="Sign in" class="android.widget.Button" clickable="true" enabled="true" bounds="[40,200][1040,320]" />
      <node text="" content-desc="Search" class="android.widget.EditText" clickable="true" bounds="[40,360][1040,440]" />
      <node text="Welcome" class="android.widget.TextView" clickable="false" bounds="[40,480][1040,520]" />
      <node text="" class="android.view.View" clickable="false" bounds="[0,600][1080,640]" />
    </node>
  </hierarchy>`;
  const snap = parseUiAutomatorDump(xml, { url: "Caliburr", title: "Caliburr" });
  expect(snap.url).toBe("Caliburr");
  expect(snap.nodes.map((n) => n.name)).toEqual(["Sign in", "Search", "Welcome"]); // unnamed non-clickable view dropped
  expect(snap.nodes[0]).toEqual({ ref: "pt:540,260", role: "Button", name: "Sign in", tag: "native" });
  expect(snap.nodes[1]).toMatchObject({ role: "EditText", name: "Search" }); // content-desc used as name
});

test("parseUiAutomatorDump tolerates junk", () => {
  expect(parseUiAutomatorDump("not xml").nodes).toEqual([]);
  expect(parseUiAutomatorDump("<hierarchy></hierarchy>").nodes).toEqual([]);
});

test("parseLogcatLine handles brief format, banners, and fallback", () => {
  expect(parseLogcatLine("E/AndroidRuntime( 1234): FATAL EXCEPTION: main")).toEqual({ level: "error", process: "AndroidRuntime", message: "FATAL EXCEPTION: main" });
  expect(parseLogcatLine("I/ReactNativeJS( 555): running app")).toEqual({ level: "info", process: "ReactNativeJS", message: "running app" });
  expect(parseLogcatLine("--------- beginning of main")).toBeNull();
  expect(parseLogcatLine("")).toBeNull();
  expect(parseLogcatLine("loose line")).toEqual({ level: "log", message: "loose line" });
  expect(androidErrorLevel("error")).toBe(true);
  expect(androidErrorLevel("info")).toBe(false);
});

test("adbLogcatArgs starts from now (-T 1, no ring-buffer dump), defaults to warning+", () => {
  expect(adbLogcatArgs(S)).toEqual(["-s", S, "logcat", "-v", "brief", "-T", "1", "*:W"]);
  expect(adbLogcatArgs(S, ["ReactNative:V", "*:E"])).toEqual(["-s", S, "logcat", "-v", "brief", "-T", "1", "ReactNative:V", "*:E"]);
});

test("parseAdbDevices + usableSerials", () => {
  const out = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n123abc\tunauthorized\n";
  expect(parseAdbDevices(out)).toEqual([
    { serial: "emulator-5554", state: "device" },
    { serial: "emulator-5556", state: "offline" },
    { serial: "123abc", state: "unauthorized" },
  ]);
  expect(usableSerials(out)).toEqual(["emulator-5554"]);
  expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
});

test("parseWmSize prefers Override over Physical", () => {
  expect(parseWmSize("Physical size: 1080x2400")).toEqual({ width: 1080, height: 2400 });
  expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600")).toEqual({ width: 720, height: 1600 });
  expect(parseWmSize("garbage")).toBeNull();
});
