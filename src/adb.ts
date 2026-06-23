/**
 * Pure helpers for driving an Android emulator/device via `adb` — the Android
 * parallel to src/idb.ts (iOS). adb taps/types/swipes by coordinate, `uiautomator
 * dump` gives the view hierarchy, and `logcat` is the native log stream.
 *
 * We turn the uiautomator XML into the same PageSnapshot shape as iOS (refs are
 * center points, "pt:x,y"), so the RN controller's click/type/snapshot work
 * platform-agnostically. Arg builders + parsers are pure and unit-tested; the live
 * `adb` spawn is injected (CI has no emulator).
 */
import type { PageSnapshot, SnapNode } from "./pageSnapshot.ts";
import type { NativeLogLine } from "./iosSimulator.ts";
import { pointRef } from "./idb.ts";

// --- adb arg builders (after `adb`) ----------------------------------------

const dev = (serial: string): string[] => (serial && serial !== "any" ? ["-s", serial] : []);

export const adbTapArgs = (serial: string, x: number, y: number): string[] => [...dev(serial), "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))];

/** `input text` treats spaces specially — encode them as %s (the documented escape). */
export const adbTextArgs = (serial: string, text: string): string[] => [...dev(serial), "shell", "input", "text", text.replace(/ /g, "%s")];

export function adbSwipeArgs(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs?: number): string[] {
  const a = [...dev(serial), "shell", "input", "swipe", String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2))];
  if (durationMs && durationMs > 0) a.push(String(Math.round(durationMs)));
  return a;
}

export const adbKeyeventArgs = (serial: string, keycode: number): string[] => [...dev(serial), "shell", "input", "keyevent", String(keycode)];

/** uiautomator XML to stdout (we strip the trailing "dumped to" line). */
export const adbUiDumpArgs = (serial: string): string[] => [...dev(serial), "exec-out", "uiautomator", "dump", "/dev/tty"];

/** PNG screenshot bytes to stdout. */
export const adbScreencapArgs = (serial: string): string[] => [...dev(serial), "exec-out", "screencap", "-p"];

/**
 * `logcat -v brief`, with an optional filterspec (e.g. ["*:W"] for warning+, or
 * ["ReactNative:V","*:E"]). Native logs parallel iOS — JS console already arrives
 * over CDP — so the default keeps warnings + errors and drops verbose chatter.
 */
export const adbLogcatArgs = (serial: string, filterSpec: string[] = ["*:W"]): string[] => [...dev(serial), "logcat", "-v", "brief", ...filterSpec];

/** Android KeyEvent codes for the keys browser_press exposes. */
const KEYCODES: Readonly<Record<string, number>> = { Enter: 66, Return: 66, Tab: 61, Escape: 111, Backspace: 67, Space: 62, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Back: 4, Home: 3 };
export const androidKeycodeFor = (key: string): number | null => KEYCODES[key] ?? null;

// --- uiautomator dump → snapshot -------------------------------------------

const NAMELEN = 80;

/**
 * Turn `uiautomator dump` XML into a PageSnapshot. Keeps nodes with on-screen
 * bounds that are either named (text/content-desc) or clickable; each ref is the
 * node's center point. Class name → role (android.widget.Button → "Button").
 */
export function parseUiAutomatorDump(xml: string, opts: { url?: string; title?: string } = {}): PageSnapshot {
  const nodes: SnapNode[] = [];
  for (const tag of xml.match(/<node\b[^>]*?>/g) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[m[1]!] = m[2]!;
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? "");
    if (!b) continue;
    const x1 = +b[1]!,
      y1 = +b[2]!,
      x2 = +b[3]!,
      y2 = +b[4]!;
    if (x2 <= x1 || y2 <= y1) continue;
    const name = (attrs.text || attrs["content-desc"] || "").trim();
    const clickable = attrs.clickable === "true";
    if (!name && !clickable) continue;
    const role = (attrs.class || "node").split(".").pop() || "node";
    const node: SnapNode = { ref: pointRef((x1 + x2) / 2, (y1 + y2) / 2), role, name: name.slice(0, NAMELEN), tag: "native" };
    if (attrs.enabled === "false") node.state = "disabled";
    nodes.push(node);
  }
  return { url: opts.url ?? "", title: opts.title ?? "", nodes };
}

// --- logcat parsing --------------------------------------------------------

// `logcat -v brief` priority letter → our normalized level.
const PRIORITY: Readonly<Record<string, string>> = { V: "debug", D: "debug", I: "info", W: "log", E: "error", F: "fault" };

/**
 * Parse a `logcat -v brief` line: "E/AndroidRuntime( 1234): message". Drops the
 * "--------- beginning of …" banners; keeps unrecognized lines as plain `log`.
 */
export function parseLogcatLine(raw: string): NativeLogLine | null {
  const line = raw.replace(/\r?\n$/, "").trimEnd();
  if (!line || /^-{3,}/.test(line)) return null;
  const m = /^([VDIWEF])\/([^(]+)\(\s*\d+\):\s?(.*)$/.exec(line);
  if (m) return { level: PRIORITY[m[1]!] ?? "log", process: m[2]!.trim(), message: m[3]! };
  return { level: "log", message: line };
}

export const androidErrorLevel = (level: string): boolean => level === "error" || level === "fault";
