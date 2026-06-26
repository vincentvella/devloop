/**
 * A shareable bug-report bundle: the diagnose summary, the timeline (logs), any
 * captured screenshots, a HAR of network, and optional repro steps — as one JSON
 * object, or rendered to a self-contained HTML report. Pure over LogEntry[].
 */

import { type DiagnoseResult, diagnose } from "./diagnose.ts";
import { toHar } from "./har.ts";
import type { LogEntry } from "./logBuffer.ts";

export interface Bundle {
  meta: {
    createdAt: number;
    app?: string;
    windowMs: number | null;
    counts: { logs: number; errors: number; network: number; screenshots: number };
  };
  diagnose: DiagnoseResult;
  logs: LogEntry[];
  har: unknown;
  screenshots: { ts: number; target?: string; image: string }[];
  repro?: unknown;
}

export function buildBundle(
  entries: LogEntry[],
  opts: { app?: string; windowMs?: number | null; repro?: unknown; now?: number } = {},
): Bundle {
  const windowMs = opts.windowMs ?? null;
  const now = opts.now ?? Date.now();
  const considered = windowMs == null ? entries : entries.filter((e) => now - e.ts <= windowMs);

  const diag = diagnose(considered, { windowMs, now });
  const har = toHar(considered);
  const screenshots = considered
    .filter((e) => e.stream === "screenshot" && (e.detail as { image?: string } | undefined)?.image)
    .map((e) => ({ ts: e.ts, target: e.target, image: (e.detail as { image: string }).image }));
  // Keep the logs copy light: pull screenshot image data out into `screenshots`.
  const logs = considered
    .slice(-2000)
    .map((e) =>
      e.stream === "screenshot" && (e.detail as { image?: string } | undefined)?.image
        ? { ...e, detail: { screenshot: true } }
        : e,
    );

  return {
    meta: {
      createdAt: now,
      app: opts.app,
      windowMs,
      counts: {
        logs: considered.length,
        errors: diag.errorCount,
        network: diag.network.length,
        screenshots: screenshots.length,
      },
    },
    diagnose: diag,
    logs,
    har,
    screenshots,
    repro: opts.repro,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render a bundle to a single self-contained HTML report (inline CSS + base64 images). */
export function bundleToHtml(b: Bundle): string {
  const d = b.diagnose;
  const errorRows = d.groups
    .map((g) => `<tr><td>${g.count}×</td><td>${g.source}:${g.stream}</td><td>${esc(g.sample)}</td></tr>`)
    .join("");
  const netRows = d.network
    .map(
      (n) =>
        `<tr><td>${n.count}×</td><td>${n.status ?? esc(n.failure ?? "")}</td><td>${esc(n.method ?? "")}</td><td>${esc(n.url)}</td></tr>`,
    )
    .join("");
  const shots = b.screenshots
    .map(
      (s) =>
        `<figure><figcaption>${new Date(s.ts).toISOString()}${s.target ? " · " + esc(s.target) : ""}</figcaption><img src="${s.image}"></figure>`,
    )
    .join("");
  const rows = b.logs
    .map(
      (e) =>
        `<div class="row ${e.source}"><span class="ts">${new Date(e.ts).toISOString().slice(11, 23)}</span><span class="tag">${e.source}:${e.stream}</span> ${esc(e.line)}</div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Devloop bug report</title>
<style>
  body{margin:0;background:#0d1117;color:#c9d1d9;font:13px/1.5 ui-monospace,Menlo,monospace}
  .wrap{max-width:1000px;margin:0 auto;padding:24px}
  h1{font-size:20px} h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#8b949e;margin-top:28px}
  .summary{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 14px}
  table{width:100%;border-collapse:collapse} td{border-bottom:1px solid #21262d;padding:4px 8px;vertical-align:top;word-break:break-all}
  figure{margin:0 0 12px} figcaption{color:#8b949e;margin-bottom:4px} img{max-width:100%;border:1px solid #30363d;border-radius:6px}
  .row{white-space:pre-wrap;word-break:break-word;padding:1px 0} .ts{color:#586069;margin-right:6px} .tag{color:#8b949e;margin-right:6px}
  .row.server .tag{color:#79c0ff} .row.browser .tag{color:#d2a8ff}
</style></head><body><div class="wrap">
  <h1>Devloop bug report</h1>
  <div class="summary">${esc(d.summary)}<br><small>${b.meta.app ? "app: " + esc(b.meta.app) + " · " : ""}${b.meta.counts.logs} log lines · ${b.meta.counts.errors} errors · ${b.meta.counts.network} network failures · ${b.meta.counts.screenshots} screenshots · ${new Date(b.meta.createdAt).toISOString()}</small></div>
  ${errorRows ? `<h2>Errors</h2><table>${errorRows}</table>` : ""}
  ${netRows ? `<h2>Network failures</h2><table>${netRows}</table>` : ""}
  ${shots ? `<h2>Screenshots</h2>${shots}` : ""}
  <h2>Timeline</h2>${rows}
</div></body></html>`;
}
