/**
 * Pure helpers for the React Native (Hermes) CDP controller — kept dependency-free
 * so they unit-test without a simulator. The controller (reactNativeController.ts)
 * wires these to a live WebSocket; the live attach is exercised by the local
 * `scripts/rn-harness.ts` against a running sim (CI has no simulator).
 */

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
  const rn = pool.filter((t) => t.reactNative || /react native|hermes|bridgeless/i.test(`${t.title ?? ""} ${t.description ?? ""}`));
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
