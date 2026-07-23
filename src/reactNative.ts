/**
 * Pure helpers for the React Native (Hermes) CDP controller — kept dependency-free
 * so they unit-test without a simulator. The controller (reactNativeController.ts)
 * wires these to a live WebSocket; the live attach is exercised by the local
 * `scripts/rn-harness.ts` against a running sim (CI has no simulator).
 */

import { pointFromRef } from "./idb.ts";
import type { SnapNode } from "./pageSnapshot.ts";

/**
 * Resolve a selector to a tappable point over a native a11y snapshot.
 *
 * Order: a literal `pt:x,y` ref → an exact accessibility-name match → a substring
 * match. Ambiguity is an error, not a silent guess: if more than one node matches
 * (multiple exact names, or a substring that hits several), we refuse rather than
 * tap whichever happens to be first in the tree — a wrong tap with no signal is
 * worse than a clear failure. Callers pass a `pt:x,y` ref (from browser_snapshot)
 * or a specific label to disambiguate.
 */
export function resolvePoint(selector: string, nodes: SnapNode[]): { x: number; y: number } {
  const literal = pointFromRef(selector);
  if (literal) return literal;

  const exact = nodes.filter((n) => n.name === selector);
  const matches = exact.length ? exact : nodes.filter((n) => n.name.includes(selector));

  if (matches.length === 0) {
    throw new Error(
      `no native element matching "${selector}" (use a "pt:x,y" ref from browser_snapshot, or its accessibility label)`,
    );
  }
  if (matches.length > 1) {
    const sample = matches
      .slice(0, 4)
      .map((n) => JSON.stringify(n.name))
      .join(", ");
    const how = exact.length ? "exactly match" : `contain "${selector}"`;
    throw new Error(
      `"${selector}" is ambiguous — ${matches.length} elements ${how} (${sample}${matches.length > 4 ? ", …" : ""}); use a "pt:x,y" ref from browser_snapshot or a more specific label`,
    );
  }

  const p = pointFromRef(matches[0]!.ref);
  if (!p) {
    throw new Error(`native element "${selector}" has no tappable point ref ("${matches[0]!.ref}")`);
  }
  return p;
}

/** A target descriptor as returned by Metro's inspector proxy `/json/list`. */
export interface InspectorTarget {
  id?: string;
  title?: string;
  description?: string;
  appId?: string;
  vm?: string;
  deviceName?: string;
  webSocketDebuggerUrl?: string;
  reactNative?: { logicalDeviceId?: string; capabilities?: Record<string, unknown> };
}

/**
 * Choose the JS-runtime (Hermes) target to attach to from a `/json/list` response.
 * Metro lists the main "React Native Bridgeless" runtime plus a secondary "UI"
 * page (the React DevTools inspector) — we want the runtime. Prefers entries with
 * a live ws url + React Native metadata, skipping the UI page, and takes the most
 * recently registered (last) so a reload's fresh target wins over a stale one.
 */
export function selectHermesTarget(targets: InspectorTarget[]): InspectorTarget | null {
  const withWs = targets.filter((t) => !!t.webSocketDebuggerUrl);
  if (!withWs.length) return null;
  const runtime = withWs.filter((t) => !/\bUI\b/.test(t.description ?? ""));
  const pool = runtime.length ? runtime : withWs;
  const rn = pool.filter(
    (t) => t.reactNative || /react native|hermes|bridgeless/i.test(`${t.title ?? ""} ${t.description ?? ""}`),
  );
  return (rn.length ? rn : pool).at(-1) ?? null;
}

/**
 * Whether a CDP `Runtime.consoleAPICalled` type is an error.
 *
 * THE KEY FINDING from the spike: React Native routes uncaught JS errors and
 * LogBox through `console.error` — NOT `Runtime.exceptionThrown` (which rarely
 * fires on RN). So error/assert console types must count as errors, or `diagnose`
 * would miss every RN crash.
 */
export function isErrorConsoleType(type: string): boolean {
  return type === "error" || type === "assert";
}

/** A CDP RemoteObject as it appears in consoleAPICalled args. */
export interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
}

/** Flatten console args into a readable line (values, or object descriptions). */
export function consoleArgsToText(args: RemoteObject[]): string {
  return args
    .map((a) => {
      if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
      return a.description ?? a.subtype ?? a.type ?? "";
    })
    .join(" ")
    .trim();
}

/**
 * Pull a stack string out of console args, if one is present — an Error object
 * surfaces its stack as the RemoteObject `description`. Used to feed source-map
 * resolution so RN's bundled stacks resolve back to original .tsx.
 */
export function errorStackFromArgs(args: RemoteObject[]): string | null {
  const err = args.find((a) => a.subtype === "error" && typeof a.description === "string");
  if (err) return err.description as string;
  return null;
}

/** Build the inspector-proxy list URL from a Metro base (e.g. http://localhost:8082). */
export function inspectorListUrl(metroBase: string): string {
  return `${metroBase.replace(/\/$/, "")}/json/list`;
}

/**
 * Only one debugger can own a Hermes target. When ours attaches but the target
 * never answers, RN DevTools ("fusebox") or the in-app JS debugger is likely
 * holding it — hint the user to close it (emitted once while we keep retrying).
 */
export const HERMES_BUSY_HINT =
  "[devloop] a React Native target isn't answering the debugger — if RN DevTools or the in-app JS debugger is attached, close it (only one debugger can own a Hermes target); Devloop will keep retrying.";

/**
 * Final message after the connect loop gives up. Distinguishes "we saw a target
 * but couldn't attach" (busy/owned elsewhere) from "no target at all" (app not
 * running / JS debugging off) — the old code always said the latter.
 */
export function connectFailureMessage(sawTarget: boolean): string {
  return sawTarget
    ? "[devloop] found a React Native (Hermes) target but couldn't attach — another debugger may own it. Close RN DevTools / the in-app debugger, then switch to the iOS target again."
    : "[devloop] no React Native (Hermes) target found via Metro — is the app running with JS debugging enabled?";
}
