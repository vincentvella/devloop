/**
 * Multi-target browser manager (cockpit). Owns N pane windows, each with its
 * own ElectronBrowserController tagging events with a pane id. Implements
 * IBrowserManager: the IBrowserController methods delegate to the ACTIVE pane,
 * so the shared tool layer (browser_*, repro) operates on whichever pane is
 * selected, while pane_* tools manage the set.
 */
import { BrowserWindow } from "electron";
import type { LogBuffer } from "../src/logBuffer.ts";
import type { IBrowserManager, PaneInfo } from "../src/browserController.ts";
import { ElectronBrowserController, type ElectronBrowserOptions } from "../src/electronBrowser.ts";

interface Pane {
  id: string;
  win: BrowserWindow;
  ctl: ElectronBrowserController;
}

export class BrowserManager implements IBrowserManager {
  private panes = new Map<string, Pane>();
  private activeId?: string;
  private counter = 0;
  /** Notified whenever the pane set or active pane changes (UI hook). */
  onChange?: () => void;

  constructor(
    private readonly buffer: LogBuffer,
    private readonly opts: ElectronBrowserOptions,
    private readonly offscreen: boolean,
  ) {}

  async start(): Promise<void> {
    await this.newPane(); // always have one pane
  }

  private active(): ElectronBrowserController {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (!p) throw new Error("no active browser pane");
    return p.ctl;
  }

  // --- IBrowserManager (pane management) ---
  async newPane(url?: string): Promise<PaneInfo> {
    const id = `pane-${++this.counter}`;
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      show: !this.offscreen,
      title: `devloop — ${id}`,
      webPreferences: { sandbox: false, offscreen: this.offscreen },
    });
    win.on("closed", () => {
      this.panes.delete(id);
      if (this.activeId === id) this.activeId = this.panes.keys().next().value;
      this.onChange?.();
    });
    await win.loadURL("about:blank");
    const ctl = new ElectronBrowserController(this.buffer, win.webContents, this.opts, id);
    await ctl.start();
    this.panes.set(id, { id, win, ctl });
    this.activeId = id;
    if (url) await ctl.navigate(url);
    this.onChange?.();
    return this.info(id);
  }

  listPanes(): PaneInfo[] {
    return [...this.panes.keys()].map((id) => this.info(id));
  }

  selectPane(id: string): PaneInfo {
    if (!this.panes.has(id)) throw new Error(`no pane "${id}"`);
    this.activeId = id;
    if (!this.offscreen) this.panes.get(id)!.win.focus();
    this.onChange?.();
    return this.info(id);
  }

  closePane(id: string): boolean {
    const p = this.panes.get(id);
    if (!p) return false;
    void p.ctl.close();
    p.win.close(); // 'closed' handler removes it and fires onChange
    return true;
  }

  private info(id: string): PaneInfo {
    const p = this.panes.get(id)!;
    return { id, url: p.ctl.currentUrl(), active: id === this.activeId };
  }

  // --- IBrowserController (delegate to active pane) ---
  navigate(url: string) {
    return this.active().navigate(url);
  }
  screenshot(fullPage?: boolean) {
    return this.active().screenshot(fullPage);
  }
  click(selector: string) {
    return this.active().click(selector);
  }
  type(selector: string, text: string) {
    return this.active().type(selector, text);
  }
  evaluate(expression: string) {
    return this.active().evaluate(expression);
  }
  waitForNetworkIdle(idleMs?: number, timeoutMs?: number) {
    return this.active().waitForNetworkIdle(idleMs, timeoutMs);
  }
  currentUrl(): string {
    return this.activeId ? this.panes.get(this.activeId)!.ctl.currentUrl() : "about:blank";
  }
  async close(): Promise<void> {
    for (const p of this.panes.values()) await p.ctl.close();
  }
}
