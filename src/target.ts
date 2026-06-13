/**
 * Target kinds + capabilities — the foundation for driving more than just a web
 * browser. Today a target is a web page (Chrome/Electron, fully capable); soon
 * it's also a React Native app in a simulator, which supports only a subset of
 * the browser tools (Phase 1: observability — eval + screenshots — no DOM-style
 * interactions or snapshot yet). The tool layer gates browser_* tools on the
 * active target's capabilities so an agent gets a clear "not supported here"
 * instead of a confusing failure.
 *
 * Pure + dependency-free so it unit-tests in isolation.
 */

export type TargetKind = "web" | "react-native";

/** Operations a target may support. One per gated browser_* tool primitive. */
export type Capability =
  | "navigate"
  | "screenshot"
  | "evaluate"
  | "click"
  | "type"
  | "hover"
  | "scroll"
  | "select"
  | "press"
  | "snapshot"
  | "waitFor"
  | "waitForNetworkIdle"
  | "clearStorage"
  | "emulate"
  | "throttle";

const WEB_CAPABILITIES: Capability[] = [
  "navigate",
  "screenshot",
  "evaluate",
  "click",
  "type",
  "hover",
  "scroll",
  "select",
  "press",
  "snapshot",
  "waitFor",
  "waitForNetworkIdle",
  "clearStorage",
  "emulate",
  "throttle",
];

// React Native, Phase 1: observability only. JS eval (Hermes Runtime.evaluate) and
// screenshots (simctl) are validated; DOM-style interactions, the a11y snapshot,
// viewport emulation, origin storage, and network idle/throttle are web concepts
// or land in later phases (idb interactions, CDP Network).
const REACT_NATIVE_CAPABILITIES: Capability[] = ["evaluate", "screenshot"];

export const CAPABILITIES: Record<TargetKind, ReadonlySet<Capability>> = {
  web: new Set(WEB_CAPABILITIES),
  "react-native": new Set(REACT_NATIVE_CAPABILITIES),
};

export function capabilitiesFor(kind: TargetKind): ReadonlySet<Capability> {
  return CAPABILITIES[kind];
}

export function supports(kind: TargetKind, cap: Capability): boolean {
  return CAPABILITIES[kind].has(cap);
}

/** Gated browser_* tools → the capability they require. Tools not listed here
 * (get_logs, dev_*, diagnose, repro, export_*, pane_*) are target-agnostic. */
export const TOOL_CAPABILITY: Readonly<Record<string, Capability>> = {
  browser_navigate: "navigate",
  browser_screenshot: "screenshot",
  browser_eval: "evaluate",
  browser_click: "click",
  browser_type: "type",
  browser_hover: "hover",
  browser_scroll: "scroll",
  browser_select: "select",
  browser_press: "press",
  browser_snapshot: "snapshot",
  browser_wait_for: "waitFor",
  browser_wait_for_idle: "waitForNetworkIdle",
  browser_clear_storage: "clearStorage",
  browser_emulate: "emulate",
  browser_throttle: "throttle",
};

/** The capability a tool requires, or null if it's target-agnostic. */
export function toolCapability(tool: string): Capability | null {
  return TOOL_CAPABILITY[tool] ?? null;
}

/** True if the tool is allowed on this target (always true for agnostic tools). */
export function isToolSupported(kind: TargetKind, tool: string): boolean {
  const cap = toolCapability(tool);
  return cap === null || supports(kind, cap);
}

export function unsupportedToolMessage(kind: TargetKind, tool: string): string {
  return `${tool} is not supported on ${kind} targets`;
}

/** Inputs for target-kind detection — a project's package.json deps + native dirs. */
export interface ProjectProbe {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  hasIosDir?: boolean;
  hasAndroidDir?: boolean;
}

/**
 * Classify a project as a web or React-Native target. RN if it depends on `expo`
 * or `react-native` (exact keys — not `react-native-web`), or has a prebuilt
 * `ios/`/`android/` directory. Everything else is web.
 */
export function detectTargetKind(probe: ProjectProbe): TargetKind {
  const deps = { ...probe.dependencies, ...probe.devDependencies };
  if (deps["expo"] || deps["react-native"] || probe.hasIosDir || probe.hasAndroidDir) {
    return "react-native";
  }
  return "web";
}
