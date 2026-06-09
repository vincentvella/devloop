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
import type { LogBuffer } from "./logBuffer.ts";
import type { IBrowserController } from "./browserController.ts";

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
  private readonly requests = new Map<string, { url: string; method: string }>();

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
    dbg.on("message", (_event, method, params) => this.onCdp(method, params));
    await dbg.sendCommand("Runtime.enable");
    await dbg.sendCommand("Network.enable");
    await dbg.sendCommand("Log.enable");
    await dbg.sendCommand("Page.enable");
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
        this.requests.set(params.requestId, { url: params.request.url, method: params.request.method });
        break;
      }
      case "Network.responseReceived": {
        const status: number = params.response.status;
        if (params.type === "Document") this.lastDocStatus = status;
        if (status >= this.opts.networkErrorThreshold) {
          this.emit("network", `${status} ${params.response.url}`, { url: params.response.url, status });
        }
        break;
      }
      case "Network.loadingFinished": {
        this.inflight = Math.max(0, this.inflight - 1);
        this.lastActivity = Date.now();
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
          { url: req?.url, failure: params.errorText },
        );
        break;
      }
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

  async evaluate(expression: string): Promise<unknown> {
    // executeJavaScript runs in the page's main world and is not blocked by CSP.
    return this.wc.executeJavaScript(expression, true);
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
