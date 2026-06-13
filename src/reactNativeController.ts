/**
 * React Native (Hermes) target controller — Phase 1 observability.
 *
 * Attaches to a running RN app over CDP via Metro's inspector proxy (the same
 * protocol Devloop already speaks to Chrome/Electron), streaming JS console +
 * errors onto the timeline with source-mapped stacks, and supporting eval +
 * screenshots. DOM-style interactions, snapshot, emulation, etc. are gated off
 * at the tool layer (capabilities for "react-native" = evaluate + screenshot).
 *
 * The CDP wiring can't run in CI (needs a simulator + Metro), so the pure bits
 * live in reactNative.ts (unit-tested) and the live attach is exercised by
 * scripts/rn-harness.ts against a booted sim.
 */
import type { IBrowserController } from "./browserController.ts";
import type { PageSnapshot } from "./pageSnapshot.ts";
import type { LogBuffer } from "./logBuffer.ts";
import { attachResolvedStack } from "./sourcemap.ts";
import {
  selectHermesTarget,
  isErrorConsoleType,
  consoleArgsToText,
  errorStackFromArgs,
  inspectorListUrl,
  type InspectorTarget,
  type RemoteObject,
} from "./reactNative.ts";

export interface ReactNativeOptions {
  /** Metro dev-server base, e.g. http://localhost:8082 */
  metroBase: string;
  /** Capture a simulator screenshot (injected so simctl stays out of the CDP core). */
  captureScreenshot?: () => Promise<{ base64: string; mimeType: string }>;
  /** Override fetch (tests/harness). */
  fetchImpl?: typeof fetch;
}

const unsupported = (op: string): never => {
  throw new Error(`${op} is not supported on react-native targets (Phase 1: observability only)`);
};

export class ReactNativeController implements IBrowserController {
  readonly kind = "react-native" as const;

  private ws?: WebSocket;
  private msgId = 0;
  private readonly pending = new Map<number, (result: unknown) => void>();
  private url = "";
  private closed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly buffer: LogBuffer,
    private readonly opts: ReactNativeOptions,
  ) {
    this.url = opts.metroBase;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  // --- CDP connection lifecycle ---------------------------------------------

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private async discover(): Promise<InspectorTarget | null> {
    try {
      const res = await this.fetch(inspectorListUrl(this.opts.metroBase));
      const list = (await res.json()) as InspectorTarget[];
      return selectHermesTarget(list);
    } catch {
      return null;
    }
  }

  /** Find the Hermes target (polling, since the app may still be loading) and attach. */
  private async connect(): Promise<void> {
    for (let i = 0; i < 30 && !this.closed; i++) {
      const target = await this.discover();
      if (target?.webSocketDebuggerUrl) {
        await this.attach(target.webSocketDebuggerUrl);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!this.closed) this.buffer.push("browser", "console", "[devloop] no React Native (Hermes) target found via Metro");
  }

  private attach(wsUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.send("Runtime.enable");
        this.send("Log.enable").catch(() => {});
        this.buffer.push("browser", "console", "[devloop] attached to React Native (Hermes) over CDP");
        resolve();
      });
      ws.addEventListener("message", (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : ""));
      ws.addEventListener("close", () => this.onDisconnect());
      ws.addEventListener("error", () => {
        /* close fires next; reconnect there */
      });
    });
  }

  /** On reload/disconnect the target id changes — re-discover and re-attach. */
  private onDisconnect(): void {
    this.ws = undefined;
    for (const resolve of this.pending.values()) resolve(undefined);
    this.pending.clear();
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => void this.connect(), 1000);
  }

  private onMessage(data: string): void {
    if (!data) return;
    let msg: { id?: number; method?: string; params?: any; result?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg.result);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") this.onConsole(msg.params);
    else if (msg.method === "Runtime.exceptionThrown") this.onException(msg.params);
  }

  private onConsole(params: { type?: string; args?: RemoteObject[] }): void {
    const type = params.type ?? "log";
    const args = params.args ?? [];
    const text = consoleArgsToText(args);
    if (isErrorConsoleType(type)) {
      // RN routes uncaught errors + LogBox through console.error — treat as a page error.
      const stack = errorStackFromArgs(args) ?? text;
      const entry = this.buffer.push("browser", "pageerror", `[${type}] ${text}`, { stack });
      if (stack) void attachResolvedStack(entry, stack); // de-minify RN bundle → original .tsx
    } else {
      this.buffer.push("browser", "console", `[${type}] ${text}`);
    }
  }

  private onException(params: { exceptionDetails?: { text?: string; exception?: { description?: string } } }): void {
    const d = params.exceptionDetails;
    const stack = d?.exception?.description ?? d?.text ?? "uncaught exception";
    const entry = this.buffer.push("browser", "pageerror", stack.split("\n")[0] ?? "uncaught exception", { stack });
    if (stack) void attachResolvedStack(entry, stack);
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(undefined);
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // --- ITargetController (supported subset) ---------------------------------

  async evaluate(expression: string): Promise<unknown> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, includeCommandLineAPI: true })) as
      | { result?: { value?: unknown; description?: string } }
      | undefined;
    return r?.result?.value ?? r?.result?.description;
  }

  async screenshot(): Promise<{ base64: string; mimeType: string }> {
    if (!this.opts.captureScreenshot) throw new Error("no screenshot capture configured for this React Native target");
    return this.opts.captureScreenshot();
  }

  currentUrl(): string {
    return this.url;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  // --- not supported in Phase 1 (also gated at the tool layer) --------------

  async navigate(): Promise<{ url: string; status: number | null }> {
    return unsupported("navigate");
  }
  async click(): Promise<void> {
    unsupported("click");
  }
  async type(): Promise<void> {
    unsupported("type");
  }
  async hover(): Promise<void> {
    unsupported("hover");
  }
  async scroll(): Promise<void> {
    unsupported("scroll");
  }
  async select(): Promise<void> {
    unsupported("select");
  }
  async press(): Promise<void> {
    unsupported("press");
  }
  async snapshot(): Promise<PageSnapshot> {
    return unsupported("snapshot");
  }
  async waitFor(): Promise<{ ok: boolean; waitedMs: number }> {
    return unsupported("wait_for");
  }
  async clearStorage(): Promise<void> {
    unsupported("clear_storage");
  }
  async emulate(): Promise<void> {
    unsupported("emulate");
  }
  async throttle(): Promise<void> {
    unsupported("throttle");
  }
  async waitForNetworkIdle(): Promise<void> {
    unsupported("wait_for_idle");
  }
}
