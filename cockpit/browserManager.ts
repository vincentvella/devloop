/**
 * Multi-target browser manager (cockpit, unified-window model).
 *
 * Each pane is a WebContentsView. The ACTIVE pane is attached to the shell
 * window and positioned over the renderer's #browserarea region; inactive panes
 * are detached from the layout but keep running (so their logs keep flowing).
 * A pane can be "popped out" into its own standalone window.
 *
 * Implements IBrowserManager: IBrowserController methods delegate to the active
 * pane; pane_* tools manage the set.
 */
import { BrowserWindow, WebContentsView } from "electron";
import type { LogBuffer } from "../src/logBuffer.ts";
import type { IBrowserManager, PaneInfo } from "../src/browserController.ts";
import { ElectronBrowserController, type ElectronBrowserOptions } from "../src/electronBrowser.ts";

interface Pane {
  id: string;
  view: WebContentsView;
  ctl: ElectronBrowserController;
  popped?: BrowserWindow; // set when detached into its own window
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class BrowserManager implements IBrowserManager {
  private panes = new Map<string, Pane>();
  private activeId?: string;
  private counter = 0;
  private shell?: BrowserWindow;
  private bounds: Rect = { x: 0, y: 0, width: 800, height: 600 };
  onChange?: () => void;

  constructor(
    private readonly buffer: LogBuffer,
    private readonly opts: ElectronBrowserOptions,
    private readonly offscreen: boolean,
  ) {}

  /** The shell window that hosts embedded (non-popped) panes. */
  attachTo(shell: BrowserWindow): void {
    this.shell = shell;
  }

  async start(): Promise<void> {
    await this.newPane();
  }

  private notify(): void {
    try {
      this.onChange?.();
    } catch {
      /* a destroyed window listener must not break teardown */
    }
  }

  private active(): ElectronBrowserController {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (!p) throw new Error("no active browser pane");
    return p.ctl;
  }

  /** Show only the active embedded pane, positioned over #browserarea. */
  private applyActive(): void {
    if (!this.shell || this.shell.isDestroyed()) return;
    for (const p of this.panes.values()) {
      if (p.popped) continue;
      try {
        this.shell.contentView.removeChildView(p.view);
      } catch {
        /* not attached */
      }
    }
    const a = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (a && !a.popped) {
      this.shell.contentView.addChildView(a.view);
      a.view.setBounds(this.bounds);
    }
  }

  /** Renderer reports the #browserarea rect; reposition the active pane. */
  setBounds(rect: Rect): void {
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const a = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (a && !a.popped && this.shell && !this.shell.isDestroyed()) a.view.setBounds(this.bounds);
  }

  // --- IBrowserManager (pane management) ---
  async newPane(url?: string): Promise<PaneInfo> {
    const id = `pane-${++this.counter}`;
    const view = new WebContentsView({ webPreferences: { sandbox: false, offscreen: this.offscreen } });
    await view.webContents.loadURL("about:blank");
    const ctl = new ElectronBrowserController(this.buffer, view.webContents, this.opts, id);
    await ctl.start();
    this.panes.set(id, { id, view, ctl });
    this.activeId = id;
    this.applyActive();
    if (url) await ctl.navigate(url);
    this.notify();
    return this.info(id);
  }

  listPanes(): PaneInfo[] {
    return [...this.panes.keys()].map((id) => this.info(id));
  }

  selectPane(id: string): PaneInfo {
    const p = this.panes.get(id);
    if (!p) throw new Error(`no pane "${id}"`);
    this.activeId = id;
    if (p.popped) {
      if (!this.offscreen) p.popped.focus();
    } else {
      this.applyActive();
    }
    this.notify();
    return this.info(id);
  }

  closePane(id: string): boolean {
    const p = this.panes.get(id);
    if (!p) return false;
    void p.ctl.close();
    if (p.popped && !p.popped.isDestroyed()) p.popped.destroy();
    else if (this.shell && !this.shell.isDestroyed()) {
      try {
        this.shell.contentView.removeChildView(p.view);
      } catch {
        /* not attached */
      }
    }
    this.panes.delete(id);
    if (this.activeId === id) {
      this.activeId = this.panes.keys().next().value;
      this.applyActive();
    }
    this.notify();
    return true;
  }

  /** Detach a pane into its own standalone window. */
  popPane(id: string): PaneInfo {
    const p = this.panes.get(id);
    if (!p) throw new Error(`no pane "${id}"`);
    if (p.popped) return this.info(id);
    if (this.shell && !this.shell.isDestroyed()) {
      try {
        this.shell.contentView.removeChildView(p.view);
      } catch {
        /* not attached */
      }
    }
    const win = new BrowserWindow({ width: 1000, height: 720, show: !this.offscreen, title: `devloop — ${id}` });
    win.contentView.addChildView(p.view);
    const fill = () => {
      const [w, h] = win.getContentSize();
      p.view.setBounds({ x: 0, y: 0, width: w, height: h });
    };
    fill();
    win.on("resize", fill);
    win.on("closed", () => this.closePane(id));
    p.popped = win;
    if (this.activeId === id) {
      this.activeId = [...this.panes.keys()].find((k) => !this.panes.get(k)!.popped);
      this.applyActive();
    }
    this.notify();
    return this.info(id);
  }

  private info(id: string): PaneInfo & { popped: boolean } {
    const p = this.panes.get(id)!;
    return { id, url: p.ctl.currentUrl(), active: id === this.activeId, popped: !!p.popped };
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
    for (const p of this.panes.values()) {
      try {
        await p.ctl.close(); // detach debugger
      } catch {
        /* ignore */
      }
      try {
        if (p.popped && !p.popped.isDestroyed()) p.popped.destroy();
      } catch {
        /* ignore */
      }
      try {
        if (!p.view.webContents.isDestroyed()) p.view.webContents.close();
      } catch {
        /* ignore */
      }
    }
    this.panes.clear();
  }
}
