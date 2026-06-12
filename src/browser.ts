/**
 * Owns a Chrome instance directly via Puppeteer (+ a raw CDP session). Browser
 * events — console messages, uncaught page errors, failed/error-status network
 * responses — are pushed into the shared LogBuffer as they happen, so they land
 * on the same timeline as the dev-server logs and `get_logs_around` can return
 * both sides of a moment.
 */

import puppeteer, {
  type Browser,
  type Page,
  type CDPSession,
  type ConsoleMessage,
  type HTTPRequest,
  type HTTPResponse,
  type KeyInput,
} from "puppeteer";
import type { LogBuffer, LogEntry } from "./logBuffer.ts";
import type { IBrowserController } from "./browserController.ts";
import { SNAPSHOT_JS, type PageSnapshot } from "./pageSnapshot.ts";
import { scrollJs, selectJs } from "./pageActions.ts";

export interface BrowserOptions {
  headless: boolean;
  executablePath?: string;
  /** Only log network responses with status >= this (failures are always logged). */
  networkErrorThreshold: number;
  /** Cap on element interactions (click/type/waitForSelector). A wedged action fails instead of hanging. */
  actionTimeoutMs: number;
  /** Cap on navigations. */
  navTimeoutMs: number;
}

export class PuppeteerBrowserController implements IBrowserController {
  private browser?: Browser;
  private page?: Page;
  private cdp?: CDPSession;
  /** Pages we've already attached event listeners to (avoid double-attaching on re-acquire). */
  private readonly configured = new WeakSet<Page>();

  constructor(
    private readonly buffer: LogBuffer,
    private readonly opts: BrowserOptions,
  ) {}

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await puppeteer.launch({
      headless: this.opts.headless,
      executablePath: this.opts.executablePath,
      defaultViewport: null,
    });
    const page = (await this.browser.pages())[0] ?? (await this.browser.newPage());
    await this.setupPage(page);
    process.stderr.write(`[devloop] browser launched (headless=${this.opts.headless})\n`);
  }

  /** Configure a page as the active one: bound timeouts, a fresh CDP session, listeners (once). */
  private async setupPage(page: Page): Promise<void> {
    // Bound every interaction so a wedged page surfaces as a fast error, not a hang.
    page.setDefaultTimeout(this.opts.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.opts.navTimeoutMs);
    if (!this.configured.has(page)) {
      page.once("close", () => {
        if (this.page === page) {
          this.page = undefined;
          this.cdp = undefined;
        }
      });
      this.attachListeners(page);
      this.configured.add(page);
    }
    this.cdp = await page.createCDPSession();
    this.page = page;
  }

  /** Return a live page, re-acquiring (and re-wiring) one if the target was lost. */
  private async ensureLivePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) throw new Error("browser not started");
    const existing = (await this.browser.pages()).find((p) => !p.isClosed());
    const page = existing ?? (await this.browser.newPage());
    await this.setupPage(page);
    this.buffer.push("browser", "console", "[info] [devloop] re-acquired browser page after target loss");
    process.stderr.write("[devloop] re-acquired browser page after target loss\n");
    return page;
  }

  private static readonly STALE = /detached|Target closed|Session closed|Execution context was destroyed|page has been closed/i;

  /** Run an op against a live page; on a detach-class error, re-acquire and retry once. */
  private async withRecovery<T>(op: (page: Page) => Promise<T>, label: string): Promise<T> {
    const page = await this.ensureLivePage();
    try {
      return await op(page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!PuppeteerBrowserController.STALE.test(msg)) throw err;
      this.buffer.push("browser", "pageerror", `[devloop] recovering ${label} from stale target: ${msg}`);
      this.page = undefined;
      this.cdp = undefined;
      const fresh = await this.ensureLivePage();
      return op(fresh); // one retry on a freshly re-acquired page
    }
  }

  private attachListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      // Reserve-then-fill: stamp the slot SYNCHRONOUSLY here so seq/ts reflect
      // true arrival order (no await before push), then resolve the args and
      // patch the same entry in place. This is what removes the ordering skew —
      // enrichment is async, but ordering and timestamps are not.
      const loc = msg.location();
      const entry = this.buffer.push("browser", "console", `[${msg.type()}] ${msg.text()}`, {
        type: msg.type(),
        url: loc.url,
        line: loc.lineNumber,
      });
      void this.enrichConsole(msg, entry);
    });

    page.on("pageerror", (raw) => {
      const err = raw as Error;
      this.buffer.push("browser", "pageerror", `${err.name}: ${err.message}`, {
        stack: err.stack,
      });
    });

    page.on("requestfailed", (req: HTTPRequest) => {
      this.buffer.push(
        "browser",
        "network",
        `FAILED ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`,
        { url: req.url(), method: req.method(), failure: req.failure()?.errorText },
      );
    });

    page.on("response", (res: HTTPResponse) => {
      const status = res.status();
      if (status < this.opts.networkErrorThreshold) return; // skip the healthy noise
      this.buffer.push("browser", "network", `${status} ${res.request().method()} ${res.url()}`, {
        url: res.url(),
        status,
        method: res.request().method(),
      });
    });
  }

  /**
   * Resolve console args to real values and patch them into an already-stamped
   * entry. Mutating the entry in place keeps its arrival-time seq/ts intact
   * while upgrading `console.log(obj)` from "JSHandle@object" to the real value.
   */
  private async enrichConsole(msg: ConsoleMessage, entry: LogEntry): Promise<void> {
    const handles = msg.args();
    if (!handles.length) return; // nothing to enrich; msg.text() placeholder stands
    const values = await Promise.all(
      handles.map(async (h) => {
        try {
          return await h.jsonValue();
        } catch {
          return h.toString(); // non-serializable (DOM nodes, functions, circular)
        }
      }),
    );
    entry.line = `[${msg.type()}] ${values
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ")}`;
    (entry.detail as Record<string, unknown>).args = values;
  }

  /** Resolve once the page has had no network activity for `idleMs`. */
  async waitForNetworkIdle(idleMs = 500, timeoutMs = 10_000): Promise<void> {
    const page = await this.ensureLivePage();
    await page.waitForNetworkIdle({ idleTime: idleMs, timeout: timeoutMs });
  }

  async navigate(url: string): Promise<{ url: string; status: number | null }> {
    return this.withRecovery(async (page) => {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      return { url: page.url(), status: resp?.status() ?? null };
    }, `navigate(${url})`);
  }

  async screenshot(fullPage = false): Promise<{ base64: string; mimeType: string }> {
    return this.withRecovery(async (page) => {
      const base64 = await page.screenshot({ encoding: "base64", fullPage, type: "png" });
      return { base64: base64 as string, mimeType: "image/png" };
    }, "screenshot");
  }

  /** Guarantee the promise settles within the action timeout, even if Puppeteer's own check stalls. */
  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} exceeded ${this.opts.actionTimeoutMs}ms (page may be wedged)`)),
          this.opts.actionTimeoutMs,
        ),
      ),
    ]);
  }

  async click(selector: string): Promise<void> {
    await this.withRecovery(
      (page) => this.withTimeout(page.click(selector), `click(${selector})`),
      `click(${selector})`,
    );
  }

  async type(selector: string, text: string): Promise<void> {
    await this.withRecovery(
      (page) => this.withTimeout(page.type(selector, text), `type(${selector})`),
      `type(${selector})`,
    );
  }

  async hover(selector: string): Promise<void> {
    await this.withRecovery((page) => this.withTimeout(page.hover(selector), `hover(${selector})`), `hover(${selector})`);
  }

  async scroll(opts: { selector?: string; x?: number; y?: number }): Promise<void> {
    await this.withRecovery(async () => {
      await this.evaluate(scrollJs(opts));
    }, "scroll");
  }

  async select(selector: string, value: string): Promise<void> {
    const ok = await this.evaluate(selectJs(selector, value));
    if (!ok) throw new Error(`No element found for selector: ${selector}`);
  }

  async press(key: string, selector?: string): Promise<void> {
    await this.withRecovery(async (page) => {
      if (selector) await this.withTimeout(page.focus(selector), `focus(${selector})`);
      await page.keyboard.press(key as KeyInput);
    }, `press(${key})`);
  }

  /** Evaluate an expression in page context via raw CDP (sidesteps page CSP on eval). */
  async evaluate(expression: string): Promise<unknown> {
    // ensureLivePage (inside withRecovery) refreshes this.cdp if the target was lost.
    return this.withRecovery(async () => {
      if (!this.cdp) throw new Error("browser not started");
      const result = await this.cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "evaluation failed");
      }
      return result.result.value;
    }, "evaluate");
  }

  async snapshot(): Promise<PageSnapshot> {
    return (await this.evaluate(SNAPSHOT_JS)) as PageSnapshot;
  }

  async waitFor(opts: { selector?: string; text?: string; timeoutMs?: number }): Promise<{ ok: boolean; waitedMs: number }> {
    const timeout = opts.timeoutMs ?? 10_000;
    const start = Date.now();
    if (!opts.selector && !opts.text) throw new Error("waitFor needs a selector or text");
    try {
      await this.withRecovery(async (page) => {
        if (opts.selector) await page.waitForSelector(opts.selector, { timeout });
        else await page.waitForFunction(`!!document.body && document.body.innerText.includes(${JSON.stringify(opts.text)})`, { timeout });
      }, "waitFor");
      return { ok: true, waitedMs: Date.now() - start };
    } catch {
      return { ok: false, waitedMs: Date.now() - start };
    }
  }

  currentUrl(): string {
    return this.page?.url() ?? "about:blank";
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
    this.cdp = undefined;
  }
}
