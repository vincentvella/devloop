/**
 * NativeDriver — the platform-specific way to perceive + drive a running native app:
 * iOS via idb, Android via adb. The ReactNativeController talks to this interface so
 * its snapshot/click/type/scroll/press are platform-agnostic (the JS-over-CDP side is
 * already shared via Metro's Hermes inspector). The live `run` (spawn) is injected;
 * the arg builders + parsers it composes are pure + unit-tested (idb.ts / adb.ts).
 */
import type { PageSnapshot } from "./pageSnapshot.ts";
import { idbDescribeAllArgs, idbKeyArgs, idbSwipeArgs, idbTapArgs, idbTextArgs, keycodeFor, parseDescribeAll } from "./idb.ts";
import { adbKeyeventArgs, adbSwipeArgs, adbTapArgs, adbTextArgs, adbUiDumpArgs, androidKeycodeFor, parseUiAutomatorDump } from "./adb.ts";

export interface NativeDriver {
  readonly platform: "ios" | "android";
  /** The a11y tree as a PageSnapshot (refs are "pt:x,y" center points). */
  snapshot(url: string): Promise<PageSnapshot>;
  tap(x: number, y: number): Promise<void>;
  /** Type into the focused field. */
  type(text: string): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  /** Press a named key; returns false if the platform has no mapping for it. */
  key(name: string): Promise<boolean>;
}

/** Run a CLI and resolve its stdout. */
export type Runner = (args: string[]) => Promise<string>;

/** iOS driver — `idb` against a booted simulator UDID. */
export function idbDriver(udid: string, run: Runner): NativeDriver {
  return {
    platform: "ios",
    snapshot: async (url) => parseDescribeAll(await run(idbDescribeAllArgs(udid)), { url, title: url }),
    tap: async (x, y) => void (await run(idbTapArgs(udid, x, y))),
    type: async (t) => void (await run(idbTextArgs(udid, t))),
    swipe: async (a, b, c, d, dur) => void (await run(idbSwipeArgs(udid, a, b, c, d, dur))),
    key: async (name) => {
      const code = keycodeFor(name);
      if (code == null) return false;
      await run(idbKeyArgs(udid, code));
      return true;
    },
  };
}

/** Android driver — `adb` against a device serial (uiautomator dump → snapshot). */
export function adbDriver(serial: string, run: Runner): NativeDriver {
  return {
    platform: "android",
    // parseUiAutomatorDump ignores the trailing "UI hierchary dumped to:" line (no <node>).
    snapshot: async (url) => parseUiAutomatorDump(await run(adbUiDumpArgs(serial)), { url, title: url }),
    tap: async (x, y) => void (await run(adbTapArgs(serial, x, y))),
    type: async (t) => void (await run(adbTextArgs(serial, t))),
    swipe: async (a, b, c, d, dur) => void (await run(adbSwipeArgs(serial, a, b, c, d, dur))),
    key: async (name) => {
      const code = androidKeycodeFor(name);
      if (code == null) return false;
      await run(adbKeyeventArgs(serial, code));
      return true;
    },
  };
}
