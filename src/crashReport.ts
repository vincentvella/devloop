/**
 * Crash → GitHub issue (the open-source alternative to a telemetry vendor).
 *
 * Instead of silently shipping stack traces to a third party, we build a prefilled
 * "new issue" URL and open it in the user's browser. They review it — so they can
 * scrub anything sensitive — and submit under their own GitHub account. No backend,
 * no secrets, no PII egress. Reports route through the `bug_report.yml` issue form
 * so they land structured + labeled.
 *
 * Pure + dependency-free so it's unit-testable and usable from any process.
 */

export const REPO = "vincentvella/devloop";

// GitHub rejects very long URLs (the practical ceiling is ~8 KB). Keep margin and
// truncate the stack if a report would exceed this.
const MAX_URL = 6000;

export interface CrashContext {
  /** Which part died — e.g. "main process", "renderer", "GPU process". */
  kind: string;
  /** The thrown value (Error or otherwise). */
  error: unknown;
  /** App version (app.getVersion()). */
  appVersion: string;
  /** process.platform, e.g. "darwin". */
  platform: string;
  /** process.arch, e.g. "arm64". */
  arch: string;
  /** Electron version, if available (process.versions.electron). */
  electronVersion?: string;
}

/** Best-effort human-readable text for any thrown value. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** A concise, deduped issue title from a crash. */
export function crashTitle(ctx: CrashContext): string {
  const first = errorText(ctx.error).split("\n")[0]!.trim().slice(0, 120);
  return `Crash (${ctx.kind}): ${first}`;
}

/** "0.6.2 · darwin arm64 · Electron 42.5.0" — fills the bug form's Version field. */
export function envLine(ctx: CrashContext): string {
  const electron = ctx.electronVersion ? ` · Electron ${ctx.electronVersion}` : "";
  return `${ctx.appVersion} · ${ctx.platform} ${ctx.arch}${electron}`;
}

/**
 * Build a prefilled GitHub issue URL for a crash, routed through the bug_report
 * form. Truncates the stack so the URL stays under GitHub's length ceiling.
 */
export function buildIssueUrl(ctx: CrashContext, repo: string = REPO): string {
  const what =
    `Devloop's ${ctx.kind} crashed. This report was generated automatically — ` +
    `please review the stack below for anything sensitive before submitting, and add ` +
    `a line about what you were doing when it happened.`;

  const base = `https://github.com/${repo}/issues/new`;
  const make = (logs: string): string => {
    const p = new URLSearchParams({
      template: "bug_report.yml",
      title: crashTitle(ctx),
      surface: "Electron cockpit",
      version: envLine(ctx),
      what,
      logs,
    });
    return `${base}?${p.toString()}`;
  };

  const stack = errorText(ctx.error);
  let url = make(stack);
  if (url.length > MAX_URL) {
    const notice = "\n... (truncated — full stack is in the app log)";
    // Trim the stack by the overflow, then tighten until under the ceiling
    // (URL-encoding expands some chars, so a single estimate can fall short).
    let keep = Math.max(0, stack.length - (url.length - MAX_URL) - 200);
    url = make(stack.slice(0, keep) + notice);
    while (url.length > MAX_URL && keep > 0) {
      keep = Math.max(0, keep - 200);
      url = make(stack.slice(0, keep) + notice);
    }
  }
  return url;
}

/** A blank prefilled bug report for the manual "Report a bug" affordance. */
export function blankIssueUrl(
  ctx: Pick<CrashContext, "appVersion" | "platform" | "arch" | "electronVersion">,
  repo: string = REPO,
): string {
  const p = new URLSearchParams({
    template: "bug_report.yml",
    surface: "Electron cockpit",
    version: envLine({ ...ctx, kind: "", error: "" }),
  });
  return `https://github.com/${repo}/issues/new?${p.toString()}`;
}
