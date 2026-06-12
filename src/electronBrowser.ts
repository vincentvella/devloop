/**
 * Electron browser substrate. Drives a BrowserWindow's webContents via the
 * raw CDP `debugger` interface, implementing the same IBrowserController
 * contract as the Puppeteer controller — so the shared tool layer works
 * unchanged with an embedded, visible window the user can also interact with.
 *
 * A nice side effect: CDP console events arrive already-serialized (args carry
 * `value`/`description`), so console rendering is synchronous — no JSHandle
 * round-trip, no reserve-then-fill ordering concern.
 */

import type { WebContents } from "electron";
import type { LogBuffer, LogEntry } from "./logBuffer.ts";
import type { IBrowserController } from "./browserController.ts";
import { SNAPSHOT_JS, type PageSnapshot } from "./pageSnapshot.ts";
import { scrollJs, selectJs, focusJs, centerJs, hoverJs, PICKER_JS } from "./pageActions.ts";

export interface ElectronBrowserOptions {
  networkErrorThreshold: number;
  actionTimeoutMs: number;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: {
    properties?: { name: string; value: string }[];
    overflow?: boolean;
  };
}

export class ElectronBrowserController implements IBrowserController {
  private inflight = 0;
  private lastActivity = 0;
  private lastDocStatus: number | null = null;
  private readonly requests = new Map<string, { url: string; method: string; postData?: string }>();
  /** Network entries awaiting their response body (fetched on loadingFinished). */
  private readonly pendingBodies = new Map<string, LogEntry>();
  private listening = false;

  constructor(
    private readonly buffer: LogBuffer,
    private readonly wc: WebContents,
    private readonly opts: ElectronBrowserOptions,
    private readonly id = "main",
  ) {}

  /** Tag every push from this pane with its target id. */
  private emit(stream: string, line: string, detail?: unknown): void {
    this.buffer.push("browser", stream, line, detail, this.id);
  }

  async start(): Promise<void> {
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    if (!this.listening) {
      dbg.on("message", (_event, method, params) => this.onCdp(method, params));
      // Self-heal: a renderer crash detaches CDP — re-attach, re-enable, and reload.
      this.wc.on("render-process-gone", (_e, details) => {
        this.emit("pageerror", `[devloop] renderer gone (${details.reason}); recovering`);
        void this.recover();
      });
      this.listening = true;
    }
    await this.enableDomains();
  }

  private async enableDomains(): Promise<void> {
    const dbg = this.wc.debugger;
    await dbg.sendCommand("Runtime.enable");
    await dbg.sendCommand("Network.enable");
    await dbg.sendCommand("Log.enable");
    await dbg.sendCommand("Page.enable");
  }

  /** Re-attach CDP and reload after a renderer crash. */
  private async recover(): Promise<void> {
    try {
      const dbg = this.wc.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      await this.enableDomains();
      this.wc.reload();
    } catch {
      /* window/view may be gone */
    }
  }

  private onCdp(method: string, params: any): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const rendered = (params.args as RemoteObject[]).map(renderRemote).join(" ");
        if (rendered.includes("Electron Security Warning")) break; // dev-only nag, not the app's
        this.emit("console", `[${params.type}] ${rendered}`, {
          type: params.type,
          args: (params.args as RemoteObject[]).map((a) => (a.value !== undefined ? a.value : a.description)),
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails ?? {};
        const ex = d.exception ?? {};
        this.emit("pageerror", ex.description ?? d.text ?? "uncaught exception", { text: d.text });
        break;
      }
      case "Network.requestWillBeSent": {
        this.inflight++;
        this.lastActivity = Date.now();
        this.requests.set(params.requestId, {
          url: params.request.url,
          method: params.request.method,
          postData: params.request.postData,
        });
        break;
      }
      case "Network.responseReceived": {
        const status: number = params.response.status;
        if (params.type === "Document") this.lastDocStatus = status;
        if (status >= this.opts.networkErrorThreshold) {
          const req = this.requests.get(params.requestId);
          const entry = this.buffer.push(
            "browser",
            "network",
            `${status} ${req?.method ?? ""} ${params.response.url}`.trim(),
            { url: params.response.url, status, method: req?.method, requestBody: cap(req?.postData) },
            this.id,
          );
          this.pendingBodies.set(params.requestId, entry); // body fetched on loadingFinished
        }
        break;
      }
      case "Network.loadingFinished": {
        this.inflight = Math.max(0, this.inflight - 1);
        this.lastActivity = Date.now();
        const entry = this.pendingBodies.get(params.requestId);
        if (entry) {
          this.pendingBodies.delete(params.requestId);
          void this.attachResponseBody(params.requestId, entry);
        }
        this.requests.delete(params.requestId);
        break;
      }
      case "Network.loadingFailed": {
        this.inflight = Math.max(0, this.inflight - 1);
        this.lastActivity = Date.now();
        const req = this.requests.get(params.requestId);
        this.requests.delete(params.requestId);
        this.emit(
          "network",
          `FAILED ${req?.method ?? ""} ${req?.url ?? params.requestId} — ${params.errorText}`,
          { url: req?.url, failure: params.errorText, requestBody: cap(req?.postData) },
        );
        this.pendingBodies.delete(params.requestId);
        break;
      }
    }
  }

  /** Fetch a logged response's body (capped) and patch it onto the entry. */
  private async attachResponseBody(requestId: string, entry: LogEntry): Promise<void> {
    try {
      const res = (await this.wc.debugger.sendCommand("Network.getResponseBody", { requestId })) as {
        body: string;
        base64Encoded: boolean;
      };
      let body: string | undefined;
      if (res.base64Encoded) {
        const buf = Buffer.from(res.body, "base64");
        body = buf.includes(0) ? `<binary ${buf.length} bytes>` : cap(buf.toString("utf8")); // decode text, flag binary
      } else {
        body = cap(res.body);
      }
      (entry.detail as Record<string, unknown>).responseBody = body;
    } catch {
      /* body unavailable (evicted, redirect, no content) */
    }
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} exceeded ${this.opts.actionTimeoutMs}ms`)), this.opts.actionTimeoutMs),
      ),
    ]);
  }

  async navigate(url: string): Promise<{ url: string; status: number | null }> {
    this.lastDocStatus = null;
    try {
      await this.wc.loadURL(url);
    } catch {
      /* loadURL rejects on ERR_ABORTED / failed loads; the failure is already in the buffer */
    }
    return { url: this.wc.getURL(), status: this.lastDocStatus };
  }

  async screenshot(_fullPage = false): Promise<{ base64: string; mimeType: string }> {
    // Electron capturePage captures the visible viewport; fullPage is not supported here.
    const img = await this.wc.capturePage();
    return { base64: img.toPNG().toString("base64"), mimeType: "image/png" };
  }

  async click(selector: string): Promise<void> {
    await this.withTimeout(
      (async () => {
        const pt = (await this.wc.executeJavaScript(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2];})()`,
        )) as [number, number] | null;
        if (!pt) throw new Error(`No element found for selector: ${selector}`);
        const [x, y] = [Math.round(pt[0]), Math.round(pt[1])];
        this.wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        this.wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      })(),
      `click(${selector})`,
    );
  }

  async type(selector: string, text: string): Promise<void> {
    await this.withTimeout(
      (async () => {
        const ok = (await this.wc.executeJavaScript(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();return true;})()`,
        )) as boolean;
        if (!ok) throw new Error(`No element found for selector: ${selector}`);
        for (const ch of text) this.wc.sendInputEvent({ type: "char", keyCode: ch });
      })(),
      `type(${selector})`,
    );
  }

  async hover(selector: string): Promise<void> {
    await this.withTimeout(
      (async () => {
        const pt = (await this.wc.executeJavaScript(centerJs(selector))) as [number, number] | null;
        if (!pt) throw new Error(`No element found for selector: ${selector}`);
        // Real pointer move (drives CSS :hover) + JS hover events (drives JS menus; works offscreen).
        this.wc.sendInputEvent({ type: "mouseMove", x: Math.round(pt[0]), y: Math.round(pt[1]) });
        await this.wc.executeJavaScript(hoverJs(selector), true);
      })(),
      `hover(${selector})`,
    );
  }

  async scroll(opts: { selector?: string; x?: number; y?: number }): Promise<void> {
    await this.wc.executeJavaScript(scrollJs(opts), true);
  }

  async select(selector: string, value: string): Promise<void> {
    const ok = (await this.wc.executeJavaScript(selectJs(selector, value), true)) as boolean;
    if (!ok) throw new Error(`No element found for selector: ${selector}`);
  }

  async press(key: string, selector?: string): Promise<void> {
    await this.withTimeout(
      (async () => {
        if (selector) {
          const ok = (await this.wc.executeJavaScript(focusJs(selector), true)) as boolean;
          if (!ok) throw new Error(`No element found for selector: ${selector}`);
        }
        this.wc.sendInputEvent({ type: "keyDown", keyCode: key });
        this.wc.sendInputEvent({ type: "keyUp", keyCode: key });
      })(),
      `press(${key})`,
    );
  }

  async evaluate(expression: string): Promise<unknown> {
    // executeJavaScript runs in the page's main world and is not blocked by CSP.
    return this.wc.executeJavaScript(expression, true);
  }

  async snapshot(): Promise<PageSnapshot> {
    return (await this.wc.executeJavaScript(SNAPSHOT_JS, true)) as PageSnapshot;
  }

  /** Interactive picker (cockpit only): resolves a selector when the user clicks an element, or null on Escape. */
  async pick(): Promise<string | null> {
    return (await this.wc.executeJavaScript(PICKER_JS, true)) as string | null;
  }

  async waitFor(opts: { selector?: string; text?: string; timeoutMs?: number }): Promise<{ ok: boolean; waitedMs: number }> {
    const timeout = opts.timeoutMs ?? 10_000;
    const start = Date.now();
    const check = opts.selector
      ? `!!document.querySelector(${JSON.stringify(opts.selector)})`
      : opts.text
        ? `!!document.body && document.body.innerText.includes(${JSON.stringify(opts.text)})`
        : null;
    if (!check) throw new Error("waitFor needs a selector or text");
    while (Date.now() - start < timeout) {
      try {
        if (await this.wc.executeJavaScript(`(${check})`, true)) return { ok: true, waitedMs: Date.now() - start };
      } catch {
        /* page mid-navigation; retry */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, waitedMs: Date.now() - start };
  }

  async waitForNetworkIdle(idleMs = 500, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.inflight === 0 && Date.now() - this.lastActivity >= idleMs) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`networkidle timeout after ${timeoutMs}ms`));
        setTimeout(check, 100);
      };
      this.lastActivity = this.lastActivity || Date.now();
      check();
    });
  }

  currentUrl(): string {
    return this.wc.getURL();
  }

  async close(): Promise<void> {
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
    } catch {
      /* already detached / window gone */
    }
  }
}

/** Cap a body to keep the buffer light; mark truncation. */
function cap(s: string | undefined, n = 2000): string | undefined {
  if (s == null) return undefined;
  return s.length > n ? `${s.slice(0, n)}…(${s.length - n} more)` : s;
}

function renderRemote(o: RemoteObject): string {
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  // Objects/arrays arrive as a CDP preview (no by-value serialization). Render it
  // so console.log(obj) shows {a: 1, b: 2} instead of "Object".
  if (o.preview?.properties) {
    const body = o.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
    const tail = o.preview.overflow ? ", …" : "";
    return o.subtype === "array" ? `[${body}${tail}]` : `{${body}${tail}}`;
  }
  return o.description ?? `<${o.type}>`;
}
