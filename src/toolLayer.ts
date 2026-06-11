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

export interface ToolDeps {
  buffer: LogBuffer;
  browser: IBrowserController;
  devServer: DevServerLike;
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
    name: "get_logs",
    description:
      "Return recent events from the unified buffer (server stdout/stderr + browser " +
      "console/network/pageerror), newest last. Filter by source, stream, grep, and " +
      "tail incrementally with sinceSeq. Scope to one project's logs with `app`.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["server", "browser"] },
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
        source: { type: "string", enum: ["server", "browser"], description: "Optional: limit to one side." },
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
    name: "dev_status",
    description: "Report whether the dev server is running, plus its cmd/cwd/pid.",
    inputSchema: { type: "object", properties: {} },
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
              kind: { type: "string", enum: ["navigate", "click", "type", "eval", "none"] },
              url: { type: "string", description: "for kind=navigate" },
              selector: { type: "string", description: "for kind=click|type" },
              text: { type: "string", description: "for kind=type" },
              expression: { type: "string", description: "for kind=eval" },
            },
            required: ["kind"],
          },
        },
        action: {
          type: "object",
          description: "A single action (convenience for a one-step sequence). Ignored if `actions` is given.",
          properties: {
            kind: { type: "string", enum: ["navigate", "click", "type", "eval", "none"] },
            url: { type: "string", description: "for kind=navigate" },
            selector: { type: "string", description: "for kind=click|type" },
            text: { type: "string", description: "for kind=type" },
            expression: { type: "string", description: "for kind=eval" },
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
  kind: "navigate" | "click" | "type" | "eval" | "none";
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
}

async function performAction(a: ReproAction): Promise<unknown> {
  const { browser } = deps;
  switch (a.kind) {
    case "navigate":
      return browser.navigate(a.url!);
    case "click":
      await browser.click(a.selector!);
      return { clicked: a.selector };
    case "type":
      await browser.type(a.selector!, a.text ?? "");
      return { typed: a.selector };
    case "eval":
      return { value: await browser.evaluate(a.expression!) };
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

export async function handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const { buffer, browser, devServer } = deps;
  switch (name) {
    case "browser_navigate":
      return json(await browser.navigate(args.url as string));
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
    case "dev_start": {
      const proj = args.project ? getProject(args.project as string) : undefined;
      if (args.project && !proj) throw new Error(`no saved project named "${args.project}"`);
      const cwd = (args.cwd as string | undefined) ?? proj?.cwd ?? process.cwd();
      const cmd = (args.cmd as string | undefined) ?? proj?.cmd ?? detectDevCommand(cwd);
      return json(devServer.start(cmd, cwd));
    }
    case "dev_stop":
      return json({ stopped: devServer.stop() });
    case "dev_status":
      return json(devServer.status());
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
