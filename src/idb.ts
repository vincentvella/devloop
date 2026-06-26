/**
 * Pure helpers for driving a booted iOS Simulator via `idb` (the iOS Development
 * Bridge) — Phase 2 native interactions + snapshot for React Native targets.
 *
 * `idb` taps/types/swipes by *coordinate*, and `idb ui describe-all` returns the
 * UIKit accessibility tree. We turn that tree into the same PageSnapshot shape the
 * web snapshot uses, where each node's `ref` encodes the element's center point
 * ("pt:x,y") — so `browser_click`/`browser_type` can target a native element by the
 * ref a snapshot handed back, exactly like the web flow.
 *
 * Arg builders + the describe-all parser are pure and unit-tested; the live `idb`
 * spawn is injected into the controller (CI has no simulator).
 */
import type { PageSnapshot, SnapNode } from "./pageSnapshot.ts";

/** A point ref, e.g. the center of an a11y element. */
export const pointRef = (x: number, y: number): string => `pt:${Math.round(x)},${Math.round(y)}`;

/** Parse a "pt:x,y" ref back to coordinates (null if it isn't one). */
export function pointFromRef(ref: string): { x: number; y: number } | null {
  const m = /^pt:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(ref.trim());
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

// --- idb arg builders (after `idb`) ----------------------------------------

export const idbTapArgs = (udid: string, x: number, y: number): string[] => [
  "ui",
  "tap",
  "--udid",
  udid,
  String(Math.round(x)),
  String(Math.round(y)),
];

export const idbTextArgs = (udid: string, text: string): string[] => ["ui", "text", "--udid", udid, text];

/** A swipe gesture (also how we scroll): from (x1,y1) to (x2,y2). */
export function idbSwipeArgs(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs?: number,
): string[] {
  const a = [
    "ui",
    "swipe",
    "--udid",
    udid,
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
  ];
  if (durationMs && durationMs > 0) a.push("--duration", String(durationMs / 1000));
  return a;
}

/** A HID keycode (e.g. 40 = Return, 42 = Backspace). */
export const idbKeyArgs = (udid: string, keycode: number): string[] => ["ui", "key", "--udid", udid, String(keycode)];

export const idbDescribeAllArgs = (udid: string): string[] => ["ui", "describe-all", "--udid", udid, "--json"];

/** USB-HID keycodes for the keys browser_press exposes (RN/native). */
const KEYCODES: Readonly<Record<string, number>> = {
  Enter: 40,
  Return: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
};
export const keycodeFor = (key: string): number | null => KEYCODES[key] ?? null;

// --- describe-all → snapshot -----------------------------------------------

interface IdbFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface IdbElement {
  frame?: IdbFrame;
  AXLabel?: string | null;
  AXValue?: string | null;
  title?: string | null;
  type?: string | null;
  role_description?: string | null;
  enabled?: boolean;
}

const NAMELEN = 80;

/**
 * Turn `idb ui describe-all --json` output into a PageSnapshot. Keeps elements
 * that have a frame and either a label/value or an interactive type; each node's
 * `ref` is its center point so a tap can be issued straight from the snapshot.
 * The full-screen root container and zero-size elements are dropped.
 */
export function parseDescribeAll(
  json: string,
  opts: { url?: string; title?: string; screen?: IdbFrame } = {},
): PageSnapshot {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return { url: opts.url ?? "", title: opts.title ?? "", nodes: [] };
  }
  if (!Array.isArray(arr)) return { url: opts.url ?? "", title: opts.title ?? "", nodes: [] };

  const nodes: SnapNode[] = [];
  for (const raw of arr as IdbElement[]) {
    const f = raw?.frame;
    if (!f || typeof f.x !== "number" || typeof f.width !== "number" || f.width <= 0 || f.height <= 0) continue;
    // Drop the root window/container that spans (roughly) the whole screen.
    if (opts.screen && f.width >= opts.screen.width && f.height >= opts.screen.height) continue;
    const role = String(raw.type ?? raw.role_description ?? "element");
    const name = String(raw.AXLabel ?? raw.title ?? raw.AXValue ?? "").trim();
    // Keep things worth acting on: anything named, or a known interactive type.
    if (!name && !/button|cell|textfield|securetextfield|switch|slider|tab|link/i.test(role)) continue;
    const node: SnapNode = {
      ref: pointRef(f.x + f.width / 2, f.y + f.height / 2),
      role,
      name: name.slice(0, NAMELEN),
      tag: "native",
    };
    if (raw.AXValue && String(raw.AXValue).trim() && String(raw.AXValue) !== name)
      node.value = String(raw.AXValue).slice(0, NAMELEN);
    if (raw.enabled === false) node.state = "disabled";
    nodes.push(node);
  }
  return { url: opts.url ?? "", title: opts.title ?? "", nodes };
}
