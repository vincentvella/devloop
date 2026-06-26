/**
 * devloop tool layer — transport- and substrate-agnostic.
 *
 * Exposes TOOLS (static schemas) and handleTool(name, args), bound to injected
 * deps via configureTools(). Reused by the stdio entry (index.ts, Puppeteer)
 * and the Electron cockpit (MCP over HTTP, Electron webContents). It never
 * touches the transport or knows which browser substrate is behind it.
 */

import { type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type LogBuffer, type LogSource } from "./logBuffer.ts";
import { detectDevCommand, type DevServerLike } from "./devServer.ts";
import { listProjects, addProject, removeProject, getProject } from "./registry.ts";
import type { IBrowserController, IBrowserManager } from "./browserController.ts";
import type { ExtListItem } from "./extensions.ts";
import { isToolSupported, unsupportedToolMessage, supports, type Capability } from "./target.ts";
import { toHar } from "./har.ts";
import { diagnose } from "./diagnose.ts";
import { buildBundle } from "./bundle.ts";

export interface ToolDeps {
  buffer: LogBuffer;
  browser: IBrowserController;
  devServer: DevServerLike;
  /** Native (iOS) interaction readiness — provided by the cockpit so `diagnose` can
   *  flag "idb not installed" on a react-native target. Absent in stdio (web-only). */
  nativeEnv?: () => { ready: boolean; summary: string } | null;
  /** Open/close a native target + run a native build — cockpit-only (needs Electron +
   *  a simulator/emulator). Absent in stdio/daemon (Puppeteer is web-only), where the
   *  native_* tools report that the cockpit is required. */
  nativeControl?: NativeControl;
  /** Chrome-extension management — cockpit-only (needs Electron sessions). Absent in
   *  stdio/daemon, where the ext_* tools report that the cockpit is required. */
  extControl?: ExtControl;
}

export interface ExtControl {
  /** Loaded (enabled) + known-disabled extensions, for the toggle list. */
  list(): ExtListItem[] | Promise<ExtListItem[]>;
  /** Install from a Chrome Web Store id or URL. Returns the updated list. */
  install(input: string): Promise<ExtListItem[]>;
  /** Uninstall (store) or unload (unpacked) an extension by id. Returns the updated list. */
  remove(id: string): Promise<ExtListItem[]>;
  /** Enable/disable an extension without uninstalling. Returns the updated list. */
  setEnabled(id: string, enabled: boolean): Promise<ExtListItem[]>;
}

export interface NativeControl {
  /** Open the iOS simulator or Android device mirror + route browser_* to it. */
  open(platform: "ios" | "android"): Promise<{ ok: boolean; summary?: string }>;
  /** Close the active native target; browser_* route back to the web pane. */
  close(): Promise<void>;
  /** Build + launch the native dev build (expo run:<platform>); streams to the timeline. */
  build(platform: "ios" | "android", cwd?: string): Promise<{ started: boolean; detail?: string }>;
}

let deps: ToolDeps;

/** Bind the tool layer to a set of runtime dependencies. Call once at startup. */
export function configureTools(d: ToolDeps): void {
  deps = d;
}

// --- tool definitions ------------------------------------------------------
export const TOOLS: Tool[] = [
  {
    name: "browser_navigate",
    description: "Navigate the browser to a URL. Returns the resolved URL and HTTP status.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "browser_back",
    description: "Go back one entry in the browser history (no-op if there's nothing to go back to).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_forward",
    description: "Go forward one entry in the browser history (no-op if there's nothing to go forward to).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_reload",
    description: "Reload the current page. Pass hard:true to bypass the cache (cockpit only; ignored under Puppeteer).",
    inputSchema: { type: "object", properties: { hard: { type: "boolean", description: "Ignore the cache (hard reload). Default false." } } },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the current page.",
    inputSchema: {
      type: "object",
      properties: { fullPage: { type: "boolean", description: "Capture the full scrollable page (default false)." } },
    },
  },
  {
    name: "browser_click",
    description: "Click the element matching a CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into the element matching a CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" } },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_eval",
    description: "Evaluate a JavaScript expression in the page (via CDP) and return the value.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover the pointer over an element (triggers hover menus/tooltips).",
    inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  },
  {
    name: "browser_scroll",
    description: "Scroll an element into view (selector), or the window to (x, y).",
    inputSchema: { type: "object", properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } } },
  },
  {
    name: "browser_select",
    description: "Set the value of a <select> (or input) and fire input/change. Pass the option's value.",
    inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] },
  },
  {
    name: "browser_press",
    description: "Press a key (e.g. Enter, Escape, Tab, ArrowDown). Optionally focus a selector first.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, selector: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_emulate",
    description:
      "Emulate a device/viewport. Pass a `device` preset (iphone|ipad|pixel), or custom `width`+`height` (with optional `mobile`, `deviceScaleFactor`, `userAgent`). `reset: true` restores a desktop viewport.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", enum: ["iphone", "ipad", "pixel"] },
        width: { type: "number" },
        height: { type: "number" },
        mobile: { type: "boolean" },
        deviceScaleFactor: { type: "number" },
        userAgent: { type: "string" },
        reset: { type: "boolean" },
      },
    },
  },
  {
    name: "browser_throttle",
    description: "Throttle network conditions: slow-3g | fast-3g | offline | none (reset).",
    inputSchema: { type: "object", properties: { profile: { type: "string", enum: ["slow-3g", "fast-3g", "offline", "none"] } }, required: ["profile"] },
  },
  {
    name: "browser_clear_storage",
    description:
      "Clear the active page's storage — cookies, localStorage, IndexedDB, cache, service workers — for the current origin (set allOrigins to wipe the whole browser session). Use to log out or test a fresh-user flow; reload afterward.",
    inputSchema: { type: "object", properties: { allOrigins: { type: "boolean", description: "Wipe the entire session, not just the current origin." } } },
  },
  {
    name: "browser_wait_for_idle",
    description: "Wait until network activity settles (no requests for idleMs). Returns { ok }.",
    inputSchema: { type: "object", properties: { idleMs: { type: "number", description: "default 500" }, timeoutMs: { type: "number", description: "default 10000" } } },
  },
  {
    name: "browser_snapshot",
    description:
      "Structured snapshot of the active page: url, title, and the interactive + landmark elements " +
      "(role, accessible name, value/state, heading level) each with a CSS selector `ref` you can pass " +
      "to browser_click / browser_type. Prefer this over a screenshot to find and target elements reliably.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait until a CSS selector appears or text is present on the page (e.g. after a navigation or async render). " +
      "Returns { ok, waitedMs } — ok=false on timeout.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for." },
        text: { type: "string", description: "Substring of page text to wait for (if no selector)." },
        timeoutMs: { type: "number", description: "Default 10000." },
      },
    },
  },
  {
    name: "get_logs",
    description:
      "Return recent events from the unified buffer (server stdout/stderr + browser " +
      "console/network/pageerror), newest last. Filter by source, stream, grep, and " +
      "tail incrementally with sinceSeq. Scope to one project's logs with `app`.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["server", "browser", "native"] },
        stream: { type: "string", description: "e.g. stdout, stderr, console, network, pageerror" },
        grep: { type: "string", description: "Case-insensitive regex (or substring if invalid)." },
        app: {
          type: "string",
          description:
            "Scope to a specific app/project's logs — matches a pane's label (project name) or id (see pane_list). " +
            "Filters both that pane's server and browser logs. Omit for all apps.",
        },
        sinceSeq: { type: "number", description: "Only events with seq >= this." },
        limit: { type: "number", description: "Max events (default 200)." },
      },
    },
  },
  {
    name: "get_logs_around",
    description:
      "THE correlation tool. Return ALL events (server + browser) within +/- windowMs of a " +
      "timestamp, time-ordered — e.g. the browser console error and the backend stack trace " +
      "from the same moment. Timestamps come from the `ts` field on any event.",
    inputSchema: {
      type: "object",
      properties: {
        ts: { type: "number", description: "Center timestamp (ms since epoch)." },
        windowMs: { type: "number", description: "Half-window in ms (default 500)." },
        source: { type: "string", enum: ["server", "browser", "native"], description: "Optional: limit to one side." },
        app: { type: "string", description: "Optional: scope to one app/project (pane label or id; see pane_list)." },
      },
      required: ["ts"],
    },
  },
  {
    name: "clear_logs",
    description: "Clear the event buffer. Call before reproducing an issue for a clean window.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "export_bundle",
    description:
      "Export a shareable bug-report bundle as one JSON object: the diagnose summary, the timeline (logs), captured screenshots, a HAR of network, and repro steps if provided. Optionally scope to an `app` / last `windowMs`.",
    inputSchema: { type: "object", properties: { app: { type: "string" }, windowMs: { type: "number" } } },
  },
  {
    name: "diagnose",
    description:
      "Triage what's broken right now: groups repeated errors (browser console/page errors + server errors) with counts, lists failed/4xx-5xx network requests, and returns a one-line summary. Optionally limit to the last `windowMs` and/or one `app`. Start here before digging through get_logs.",
    inputSchema: {
      type: "object",
      properties: {
        windowMs: { type: "number", description: "Only consider events from the last N ms (default: all)." },
        app: { type: "string", description: "Scope to one app/project (pane label or id)." },
      },
    },
  },
  {
    name: "export_har",
    description:
      "Export captured network requests as a HAR 1.2 document (importable into Chrome DevTools / Charles). " +
      "Covers ALL requests (the full network ring, independent of DEVLOOP_NET_THRESHOLD — bodies are kept for the " +
      "curated subset: failures + status ≥ threshold). Optionally scope to one `app` (pane label/id).",
    inputSchema: { type: "object", properties: { app: { type: "string" } } },
  },
  {
    name: "get_network",
    description:
      "List captured network requests (the full ring — every request, independent of DEVLOOP_NET_THRESHOLD, " +
      "unlike get_logs which shows only the curated timeline). Each row has method/url/status/timing/headers " +
      "(bodies for the curated subset). Optionally `grep` the request line, scope to one `app`, and cap with `limit`.",
    inputSchema: {
      type: "object",
      properties: {
        grep: { type: "string", description: "Substring match on the request line (status/method/url)." },
        app: { type: "string", description: "Scope to one app/project (pane label or id)." },
        limit: { type: "number", description: "Max rows (most recent), default 200." },
      },
    },
  },
  {
    name: "dev_start",
    description:
      "Start a dev server and tee its logs into the buffer. Three ways to specify it: " +
      "(1) `project` — a saved registry project (resolves cmd/cwd); (2) explicit `cmd`+`cwd`; " +
      "(3) neither — `cwd` defaults to the server's directory and `cmd` is auto-detected from " +
      "package.json (dev/develop/web/start/serve). Explicit cmd/cwd override the project's.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Name of a saved project (see project_list)." },
        cmd: { type: "string", description: "Full dev command. If omitted, auto-detected from package.json." },
        cwd: { type: "string", description: "Project directory. Defaults to the server's cwd." },
      },
    },
  },
  {
    name: "dev_stop",
    description: "Stop the running dev server (SIGTERM). Returns whether one was running.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_list",
    description: "List saved projects (name, cwd, cmd, url) from the registry.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_add",
    description: "Save (or replace) a project in the registry so you can dev_start it by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        cwd: { type: "string", description: "Project directory." },
        cmd: { type: "string", description: "Dev command (optional; auto-detected if omitted)." },
        url: { type: "string", description: "Default URL to open in the browser pane (optional)." },
      },
      required: ["name", "cwd"],
    },
  },
  {
    name: "project_remove",
    description: "Remove a project from the registry by name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "pane_list",
    description: "List browser panes (multi-target). Each: id, url, active. The active pane is what browser_*/repro act on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pane_new",
    description: "Open a new browser pane and make it active. Optionally navigate it to a URL. (Cockpit only.)",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  },
  {
    name: "pane_select",
    description: "Make a pane active so subsequent browser_*/repro calls target it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "pane_close",
    description: "Close a browser pane by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "pane_pop",
    description: "Detach a pane into its own standalone window (so you can view targets side-by-side).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "pane_set_label",
    description: "Set a pane's display label (the tab name). Used to scope log queries by app name. (Cockpit only.)",
    inputSchema: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] },
  },
  {
    name: "dev_status",
    description: "Report whether the dev server is running, plus its cmd/cwd/pid.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "native_open",
    description:
      "Open a native target for the active pane (Expo/React Native): the iOS simulator or the Android device " +
      "mirror. browser_* (snapshot/click/type/scroll/press/screenshot) then drive the native app via idb/adb, " +
      "and JS + native logs stream to the timeline. Cockpit-only (needs the Electron app + a booted simulator/" +
      "emulator). Returns ok:false with a reason if the device/tooling isn't ready.",
    inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["ios", "android"] } }, required: ["platform"] },
  },
  {
    name: "native_close",
    description: "Close the active native target; browser_* route back to the pane's web content. Cockpit-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "native_build",
    description:
      "Build + launch the native dev build for the active pane (`expo run:ios` / `expo run:android`); output " +
      "streams to the timeline. `cwd` defaults to the active pane's project. Cockpit-only (needs the native toolchain).",
    inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["ios", "android"] }, cwd: { type: "string" } }, required: ["platform"] },
  },
  {
    name: "ext_list",
    description: "List Chrome extensions (loaded + disabled): id, name, version, enabled. Cockpit only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ext_install",
    description: "Install a Chrome extension from a Web Store id or URL. Returns the updated list. Cockpit only.",
    inputSchema: { type: "object", properties: { input: { type: "string", description: "Extension id or Chrome Web Store URL." } }, required: ["input"] },
  },
  {
    name: "ext_remove",
    description: "Remove (uninstall/unload) a Chrome extension by id. Returns the updated list. Cockpit only.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "ext_set_enabled",
    description: "Enable or disable a Chrome extension by id without uninstalling. Returns the updated list. Cockpit only.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
  },
  {
    name: "repro",
    description:
      "One-shot reproduce-and-correlate. Clears the buffer (unless clear=false), performs one " +
      "action OR a sequence of actions in order, waits for async console/network/server events " +
      "to land, then returns EVERYTHING that happened on both sides across the whole sequence, " +
      "plus per-step results and an errors summary (console errors, page errors, failed/4xx-5xx " +
      "network). Use a sequence for flows like navigate → click → type → click submit.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Sequence of actions performed in order. Use this OR `action`.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["navigate", "click", "type", "hover", "scroll", "select", "press", "eval", "wait", "none"] },
              url: { type: "string", description: "for kind=navigate" },
              selector: { type: "string", description: "for kind=click|type|hover|select|wait (and optional for scroll/press)" },
              text: { type: "string", description: "for kind=type, or kind=wait (text to wait for)" },
              expression: { type: "string", description: "for kind=eval" },
              key: { type: "string", description: "for kind=press (e.g. Enter, Escape, Tab)" },
              value: { type: "string", description: "for kind=select" },
              x: { type: "number", description: "for kind=scroll" },
              y: { type: "number", description: "for kind=scroll" },
              timeoutMs: { type: "number", description: "for kind=wait" },
            },
            required: ["kind"],
          },
        },
        action: {
          type: "object",
          description: "A single action (convenience for a one-step sequence). Ignored if `actions` is given.",
          properties: {
            kind: { type: "string", enum: ["navigate", "click", "type", "hover", "scroll", "select", "press", "eval", "wait", "none"] },
            url: { type: "string", description: "for kind=navigate" },
            selector: { type: "string", description: "for kind=click|type|hover|select|wait (and optional for scroll/press)" },
            text: { type: "string", description: "for kind=type, or kind=wait (text to wait for)" },
            expression: { type: "string", description: "for kind=eval" },
            key: { type: "string", description: "for kind=press" },
            value: { type: "string", description: "for kind=select" },
            x: { type: "number", description: "for kind=scroll" },
            y: { type: "number", description: "for kind=scroll" },
            timeoutMs: { type: "number", description: "for kind=wait" },
          },
          required: ["kind"],
        },
        waitFor: {
          type: "string",
          enum: ["settle", "networkidle"],
          description:
            "How to wait after each action. 'settle' = fixed sleep. 'networkidle' = wait until " +
            "the page has no network activity (more reliable for slow/streaming responses). " +
            "Default 'settle'. Applied between steps too, so the next step's target is ready.",
        },
        settleMs: { type: "number", description: "Fixed wait after the FINAL action for waitFor=settle (default 1000)." },
        stepSettleMs: { type: "number", description: "Fixed wait BETWEEN steps for waitFor=settle (default 300)." },
        idleMs: { type: "number", description: "Quiet period that counts as idle for waitFor=networkidle (default 500)." },
        timeoutMs: { type: "number", description: "Max wait for waitFor=networkidle before giving up (default 10000)." },
        continueOnError: { type: "boolean", description: "Keep going if a step fails (default false: stop after the failing step)." },
        clear: { type: "boolean", description: "Clear the buffer first (default true)." },
      },
    },
  },
];

interface ReproAction {
  kind: "navigate" | "click" | "type" | "hover" | "scroll" | "select" | "press" | "eval" | "wait" | "none";
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
  timeoutMs?: number;
  key?: string;
  value?: string;
  x?: number;
  y?: number;
}

/** Each repro step maps to the capability its browser_* primitive needs, so a step
 *  unsupported on the active target (e.g. navigate/hover on a react-native iOS target)
 *  fails with a clear message the repro loop records per-step — instead of a raw throw. */
const ACTION_CAPABILITY: Record<ReproAction["kind"], Capability | null> = {
  navigate: "navigate",
  click: "click",
  type: "type",
  hover: "hover",
  scroll: "scroll",
  select: "select",
  press: "press",
  eval: "evaluate",
  wait: "waitFor",
  none: null,
};

async function performAction(a: ReproAction): Promise<unknown> {
  const { browser } = deps;
  const cap = ACTION_CAPABILITY[a.kind];
  if (cap && !supports(browser.kind, cap)) throw new Error(`repro step "${a.kind}" is not supported on ${browser.kind} targets`);
  switch (a.kind) {
    case "navigate":
      return browser.navigate(a.url!);
    case "click":
      await browser.click(a.selector!);
      return { clicked: a.selector };
    case "type":
      await browser.type(a.selector!, a.text ?? "");
      return { typed: a.selector };
    case "hover":
      await browser.hover(a.selector!);
      return { hovered: a.selector };
    case "scroll":
      await browser.scroll({ selector: a.selector, x: a.x, y: a.y });
      return { scrolled: true };
    case "select":
      await browser.select(a.selector!, a.value ?? a.text ?? "");
      return { selected: a.value ?? a.text };
    case "press":
      await browser.press(a.key!, a.selector);
      return { pressed: a.key };
    case "eval":
      return { value: await browser.evaluate(a.expression!) };
    case "wait":
      return browser.waitFor({ selector: a.selector, text: a.text, timeoutMs: a.timeoutMs });
    case "none":
      return { noop: true };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait per the chosen strategy. Returns a note if networkidle timed out. */
async function waitAfter(opts: {
  waitFor: "settle" | "networkidle";
  fixedMs: number;
  idleMs: number;
  timeoutMs: number;
}): Promise<string | undefined> {
  if (opts.waitFor === "networkidle") {
    let note: string | undefined;
    try {
      await deps.browser.waitForNetworkIdle(opts.idleMs, opts.timeoutMs);
    } catch {
      note = `networkidle not reached within ${opts.timeoutMs}ms`;
    }
    await sleep(150); // let trailing console events flush
    return note;
  }
  await sleep(opts.fixedMs);
  return undefined;
}

interface ReproStep {
  index: number;
  action: ReproAction;
  result?: unknown;
  error?: string;
  durationMs: number;
  waitNote?: string;
}

const ERROR_STREAMS = new Set(["pageerror", "network"]);

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Narrow the active browser to a multi-pane manager, or explain it's unavailable. */
function asManager(): IBrowserManager {
  const b = deps.browser as Partial<IBrowserManager>;
  if (typeof b.listPanes !== "function") {
    throw new Error("multi-pane browser is only available in the cockpit (Electron) mode");
  }
  return b as IBrowserManager;
}

/**
 * Resolve an `app` name (or pane id) to the matching pane target ids, so log
 * reads can be scoped to one project's logs. Matches a pane's label or id,
 * case-insensitively, exact-first then substring. Returns undefined (no filter)
 * if there's no multi-pane manager or nothing matches.
 */
function resolveTargets(app: string | undefined): string[] | undefined {
  if (!app) return undefined;
  const b = deps.browser as Partial<IBrowserManager>;
  if (typeof b.listPanes !== "function") return undefined; // single-pane (stdio) — nothing to scope
  const panes = (b as IBrowserManager).listPanes();
  const q = app.toLowerCase();
  const exact = panes.filter((p) => p.label?.toLowerCase() === q || p.id.toLowerCase() === q);
  const matched = exact.length ? exact : panes.filter((p) => p.label?.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  if (!matched.length) throw new Error(`no pane/app matching "${app}" (see pane_list for labels)`);
  return matched.map((p) => p.id);
}

export async function handleTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const { buffer, browser, devServer } = deps;
  // Gate browser_* tools on the active target's capabilities (e.g. a React Native
  // target supports eval+screenshot but not snapshot/click yet) so an agent gets a
  // clear message instead of a substrate error. Agnostic tools pass through.
  if (!isToolSupported(browser.kind, name)) {
    return { ...json({ error: unsupportedToolMessage(browser.kind, name), kind: browser.kind }), isError: true };
  }
  switch (name) {
    case "browser_navigate":
      return json(await browser.navigate(args.url as string));
    case "browser_back":
      await browser.back();
      return json({ ok: true });
    case "browser_forward":
      await browser.forward();
      return json({ ok: true });
    case "browser_reload":
      await browser.reload(args.hard as boolean | undefined);
      return json({ ok: true });
    case "browser_screenshot": {
      const shot = await browser.screenshot((args.fullPage as boolean) ?? false);
      return { content: [{ type: "image", data: shot.base64, mimeType: shot.mimeType }] };
    }
    case "browser_click":
      await browser.click(args.selector as string);
      return json({ ok: true });
    case "browser_type":
      await browser.type(args.selector as string, args.text as string);
      return json({ ok: true });
    case "browser_eval":
      return json({ value: await browser.evaluate(args.expression as string) });
    case "browser_hover":
      await browser.hover(args.selector as string);
      return json({ hovered: args.selector });
    case "browser_scroll":
      await browser.scroll({ selector: args.selector as string | undefined, x: args.x as number | undefined, y: args.y as number | undefined });
      return json({ ok: true });
    case "browser_select":
      await browser.select(args.selector as string, args.value as string);
      return json({ selected: args.value });
    case "browser_press":
      await browser.press(args.key as string, args.selector as string | undefined);
      return json({ pressed: args.key });
    case "browser_clear_storage":
      await browser.clearStorage({ allOrigins: args.allOrigins as boolean | undefined });
      return json({ ok: true });
    case "browser_emulate":
      await browser.emulate({
        device: args.device as string | undefined,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
        deviceScaleFactor: args.deviceScaleFactor as number | undefined,
        mobile: args.mobile as boolean | undefined,
        userAgent: args.userAgent as string | undefined,
        reset: args.reset as boolean | undefined,
      });
      return json({ ok: true });
    case "browser_throttle":
      await browser.throttle(args.profile as string);
      return json({ ok: true });
    case "browser_wait_for_idle":
      try {
        await browser.waitForNetworkIdle(args.idleMs as number | undefined, args.timeoutMs as number | undefined);
        return json({ ok: true });
      } catch {
        return json({ ok: false });
      }
    case "browser_snapshot":
      return json(await browser.snapshot());
    case "browser_wait_for":
      return json(
        await browser.waitFor({
          selector: args.selector as string | undefined,
          text: args.text as string | undefined,
          timeoutMs: args.timeoutMs as number | undefined,
        }),
      );
    case "get_logs": {
      const targets = resolveTargets(args.app as string | undefined);
      const entries = buffer.query({
        source: args.source as LogSource | undefined,
        stream: args.stream as string | undefined,
        grep: args.grep as string | undefined,
        sinceSeq: args.sinceSeq as number | undefined,
        limit: args.limit as number | undefined,
        targets,
      });
      return json({ latestSeq: buffer.latestSeq, count: entries.length, entries });
    }
    case "get_logs_around": {
      const ts = args.ts as number;
      const windowMs = (args.windowMs as number | undefined) ?? 500;
      const targets = resolveTargets(args.app as string | undefined);
      const entries = buffer.around(ts, windowMs, args.source as LogSource | undefined, targets);
      return json({ ts, windowMs, count: entries.length, entries });
    }
    case "clear_logs":
      buffer.clear();
      return json({ ok: true, latestSeq: buffer.latestSeq });
    case "export_har": {
      const targets = resolveTargets(args.app as string | undefined);
      // Full network ring (#26) — complete HAR regardless of DEVLOOP_NET_THRESHOLD.
      const entries = buffer.netEntries({ targets, limit: 5000 });
      return json(toHar(entries));
    }
    case "get_network": {
      const targets = resolveTargets(args.app as string | undefined);
      const limit = typeof args.limit === "number" ? args.limit : 200;
      let entries = buffer.netEntries({ targets });
      if (typeof args.grep === "string" && args.grep) {
        const needle = (args.grep as string).toLowerCase();
        entries = entries.filter((e) => e.line.toLowerCase().includes(needle));
      }
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      return json(entries.map((e) => ({ ts: e.ts, target: e.target, ...(e.detail as Record<string, unknown>) })));
    }
    case "diagnose": {
      const targets = resolveTargets(args.app as string | undefined);
      const entries = buffer.query({ targets, limit: 5000 });
      const result = diagnose(entries, { windowMs: args.windowMs as number | undefined });
      // #21: on a react-native target, surface idb/native readiness in triage too.
      const ne = deps.browser.kind === "react-native" ? deps.nativeEnv?.() : null;
      if (ne && !ne.ready) {
        result.nativeNotes.push(ne.summary);
        result.summary = result.summary === "no errors detected" ? ne.summary : `${ne.summary} | ${result.summary}`;
      }
      return json(result);
    }
    case "export_bundle": {
      const targets = resolveTargets(args.app as string | undefined);
      const entries = buffer.query({ targets, limit: 5000 });
      return json(buildBundle(entries, { app: args.app as string | undefined, windowMs: args.windowMs as number | undefined }));
    }
    case "dev_start": {
      const proj = args.project ? getProject(args.project as string) : undefined;
      if (args.project && !proj) throw new Error(`no saved project named "${args.project}"`);
      const cwd = (args.cwd as string | undefined) ?? proj?.cwd ?? process.cwd();
      const cmd = (args.cmd as string | undefined) ?? proj?.cmd ?? detectDevCommand(cwd);
      return json(await devServer.start(cmd, cwd));
    }
    case "dev_stop":
      return json({ stopped: devServer.stop() });
    case "dev_status":
      return json(devServer.status());
    case "native_open": {
      if (!deps.nativeControl) throw new Error("native targets require the Devloop cockpit (run the Electron app); the headless server is web-only");
      return json(await deps.nativeControl.open(args.platform as "ios" | "android"));
    }
    case "native_close": {
      if (!deps.nativeControl) throw new Error("native targets require the Devloop cockpit (run the Electron app); the headless server is web-only");
      await deps.nativeControl.close();
      return json({ ok: true });
    }
    case "native_build": {
      if (!deps.nativeControl) throw new Error("native builds require the Devloop cockpit (run the Electron app); the headless server is web-only");
      return json(await deps.nativeControl.build(args.platform as "ios" | "android", args.cwd as string | undefined));
    }
    case "project_list":
      return json({ projects: listProjects() });
    case "project_add":
      return json({
        projects: addProject({
          name: args.name as string,
          cwd: args.cwd as string,
          cmd: args.cmd as string | undefined,
          url: args.url as string | undefined,
          steps: args.steps as { kind: string }[] | undefined,
        }),
      });
    case "project_remove":
      return json({ projects: removeProject(args.name as string) });
    case "pane_list":
      return json({ panes: asManager().listPanes() });
    case "pane_new":
      return json(await asManager().newPane(args.url as string | undefined));
    case "pane_select":
      return json(asManager().selectPane(args.id as string));
    case "pane_close":
      return json({ closed: asManager().closePane(args.id as string) });
    case "pane_pop":
      return json(asManager().popPane(args.id as string));
    case "pane_set_label":
      asManager().setLabel(args.id as string, args.label as string);
      return json({ ok: true });
    case "ext_list": {
      if (!deps.extControl) throw new Error("extensions require the Devloop cockpit (run the Electron app); the headless server is web-only");
      return json({ extensions: await deps.extControl.list() });
    }
    case "ext_install": {
      if (!deps.extControl) throw new Error("extensions require the Devloop cockpit (run the Electron app); the headless server is web-only");
      return json({ extensions: await deps.extControl.install(args.input as string) });
    }
    case "ext_remove": {
      if (!deps.extControl) throw new Error("extensions require the Devloop cockpit (run the Electron app); the headless server is web-only");
      return json({ extensions: await deps.extControl.remove(args.id as string) });
    }
    case "ext_set_enabled": {
      if (!deps.extControl) throw new Error("extensions require the Devloop cockpit (run the Electron app); the headless server is web-only");
      return json({ extensions: await deps.extControl.setEnabled(args.id as string, args.enabled as boolean) });
    }
    case "repro": {
      const waitFor = (args.waitFor as "settle" | "networkidle" | undefined) ?? "settle";
      const settleMs = (args.settleMs as number | undefined) ?? 1000;
      const stepSettleMs = (args.stepSettleMs as number | undefined) ?? 300;
      const idleMs = (args.idleMs as number | undefined) ?? 500;
      const timeoutMs = (args.timeoutMs as number | undefined) ?? 10_000;
      const continueOnError = (args.continueOnError as boolean | undefined) ?? false;

      // Normalize to a sequence: `actions` wins, else wrap the single `action`.
      const actions: ReproAction[] = Array.isArray(args.actions)
        ? (args.actions as ReproAction[])
        : args.action
          ? [args.action as ReproAction]
          : [];
      if (!actions.length) {
        return {
          isError: true,
          content: [{ type: "text", text: "repro requires `actions` (array) or `action` (single)." }],
        };
      }

      if ((args.clear as boolean | undefined) ?? true) buffer.clear();

      const startSeq = buffer.latestSeq + 1;
      const t0 = Date.now();
      const steps: ReproStep[] = [];
      let stoppedAtStep: number | null = null;

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i]!;
        const stepT0 = Date.now();
        let result: unknown;
        let error: string | undefined;
        try {
          result = await performAction(action);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const willStop = !!error && !continueOnError;
        const finalWait = i === actions.length - 1 || willStop; // full settle on last/aborting step
        const waitNote = await waitAfter({
          waitFor,
          fixedMs: finalWait ? settleMs : stepSettleMs,
          idleMs,
          timeoutMs,
        });
        steps.push({ index: i, action, result, error, durationMs: Date.now() - stepT0, waitNote });

        if (willStop) {
          stoppedAtStep = i;
          break;
        }
      }

      const entries = buffer.query({ sinceSeq: startSeq, limit: 2000 });
      const errors = entries.filter(
        (e) =>
          ERROR_STREAMS.has(e.stream) ||
          (e.stream === "console" && /\[error\]/.test(e.line)) ||
          (e.source === "native" && (e.stream === "error" || e.stream === "fault")) ||
          (e.source === "server" && /error|exception|traceback|unhandled/i.test(e.line)),
      );
      const byStream: Record<string, number> = {};
      for (const e of entries) byStream[`${e.source}:${e.stream}`] = (byStream[`${e.source}:${e.stream}`] ?? 0) + 1;

      return json({
        waitFor,
        stepCount: steps.length,
        stoppedAtStep,
        steps,
        // back-compat for single-action callers:
        actionResult: steps.length === 1 ? steps[0]!.result : undefined,
        actionError: steps.length === 1 ? steps[0]!.error : undefined,
        waitNote: steps[steps.length - 1]?.waitNote,
        durationMs: Date.now() - t0,
        total: entries.length,
        byStream,
        errorCount: errors.length,
        errors,
        entries,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
