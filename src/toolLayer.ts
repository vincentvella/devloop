/**
 * devloop tool layer — transport- and substrate-agnostic.
 *
 * Exposes TOOLS (static schemas) and handleTool(name, args), bound to injected
 * deps via configureTools(). Reused by the stdio entry (index.ts, Puppeteer)
 * and the Electron cockpit (MCP over HTTP, Electron webContents). It never
 * touches the transport or knows which browser substrate is behind it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IBrowserController, IBrowserManager } from "./browserController.ts";
import { buildBundle } from "./bundle.ts";
import { type DevServerLike, detectDevCommand } from "./devServer.ts";
import { diagnose } from "./diagnose.ts";
import type { ExtListItem } from "./extensions.ts";
import { toHar } from "./har.ts";
import type { LogBuffer, LogSource } from "./logBuffer.ts";
import { addProject, getProject, listProjects, removeProject } from "./registry.ts";
import { type Capability, isToolSupported, supports, unsupportedToolMessage } from "./target.ts";
import { isToolName } from "./toolSpecs.ts";

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
  /** Build + launch the native dev build; streams to the timeline. `eas` runs a
   *  cloud build (`eas build`) instead of a local `expo run:<platform>`. */
  build(platform: "ios" | "android", cwd?: string, eas?: boolean): Promise<{ started: boolean; detail?: string }>;
}

let deps: ToolDeps;

/** Bind the tool layer to a set of runtime dependencies. Call once at startup. */
export function configureTools(d: ToolDeps): void {
  deps = d;
}

// Tool schemas/prose live in toolSpecs.ts (authored via defineTool so per-param
// descriptions are mandatory by construction — see src/defineTool.ts). handleTool
// below dispatches by name.
export { TOOLS } from "./toolSpecs.ts";

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
  if (cap && !supports(browser.kind, cap))
    throw new Error(`repro step "${a.kind}" is not supported on ${browser.kind} targets`);
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
export function resolveTargets(app: string | undefined): string[] | undefined {
  if (!app) return undefined;
  const b = deps.browser as Partial<IBrowserManager>;
  if (typeof b.listPanes !== "function") return undefined; // single-pane (stdio) — nothing to scope
  const panes = (b as IBrowserManager).listPanes();
  const q = app.toLowerCase();
  const exact = panes.filter((p) => p.label?.toLowerCase() === q || p.id.toLowerCase() === q);
  const matched = exact.length
    ? exact
    : panes.filter((p) => p.label?.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  if (!matched.length) throw new Error(`no pane/app matching "${app}" (see pane_list for labels)`);
  return matched.map((p) => p.id);
}

export async function handleTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const { buffer, browser, devServer } = deps;
  if (!isToolName(name)) throw new Error(`Unknown tool: ${name}`);
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
      await browser.scroll({
        selector: args.selector as string | undefined,
        x: args.x as number | undefined,
        y: args.y as number | undefined,
      });
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
      return json(await browser.snapshot(args.limit as number | undefined));
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
      return json(
        buildBundle(entries, { app: args.app as string | undefined, windowMs: args.windowMs as number | undefined }),
      );
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
      if (!deps.nativeControl)
        throw new Error(
          "native targets require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
      return json(await deps.nativeControl.open(args.platform as "ios" | "android"));
    }
    case "native_close": {
      if (!deps.nativeControl)
        throw new Error(
          "native targets require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
      await deps.nativeControl.close();
      return json({ ok: true });
    }
    case "native_build": {
      if (!deps.nativeControl)
        throw new Error(
          "native builds require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
      return json(
        await deps.nativeControl.build(
          args.platform as "ios" | "android",
          args.cwd as string | undefined,
          args.eas as boolean | undefined,
        ),
      );
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
      if (!deps.extControl)
        throw new Error(
          "extensions require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
      return json({ extensions: await deps.extControl.list() });
    }
    case "ext_install": {
      if (!deps.extControl)
        throw new Error(
          "extensions require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
      return json({ extensions: await deps.extControl.install(args.input as string) });
    }
    case "ext_remove": {
      if (!deps.extControl)
        throw new Error(
          "extensions require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
      return json({ extensions: await deps.extControl.remove(args.id as string) });
    }
    case "ext_set_enabled": {
      if (!deps.extControl)
        throw new Error(
          "extensions require the Devloop cockpit (run the Electron app); the headless server is web-only",
        );
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
    default: {
      // Exhaustiveness: once every ToolName is cased above, `name` is `never` here.
      // Add a tool to toolSpecs.ts without a handler and this fails `bun run typecheck`.
      const _exhaustive: never = name;
      throw new Error(`Unhandled tool: ${String(_exhaustive)}`);
    }
  }
}
