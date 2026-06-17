/**
 * Multi-target browser manager (cockpit, unified-window model).
 *
 * Each pane is a WebContentsView with its OWN dev server (per-pane project) and
 * dev config. The active pane is attached to the shell window over the
 * renderer's #browserarea region; inactive panes are detached from the layout
 * but keep running (logs keep flowing). A pane can be popped into its own window.
 *
 * Implements IBrowserManager: IBrowserController methods delegate to the active
 * pane; dev lifecycle (start/stop/restart/reload) is per-pane.
 */
import { BrowserWindow, WebContentsView } from "electron";
import type { LogBuffer } from "../src/logBuffer.ts";
import type { IBrowserManager, PaneInfo } from "../src/browserController.ts";
import type { TargetKind } from "../src/target.ts";
import { getPanes, setPanes } from "../src/registry.ts";
import { DevServer, detectDevCommand, type DevStatus } from "../src/devServer.ts";

/** Persistent session shared by all panes — separate from the shell's default session so
 *  loaded extensions (and their content scripts) never inject into the cockpit UI itself. */
export const PANE_PARTITION = "persist:devloop-panes";
import { ElectronBrowserController, type ElectronBrowserOptions } from "../src/electronBrowser.ts";

interface Pane {
  id: string;
  view: WebContentsView;
  ctl: ElectronBrowserController;
  dev: DevServer; // this pane's own dev server
  cmd?: string;
  cwd?: string;
  label?: string;
  url: string; // canonical URL (persisted) — may differ from what's displayed (e.g. a placeholder)
  awaitingUrl?: boolean; // auto-navigate this pane to the first server URL it logs
  popped?: BrowserWindow;
}

const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url);

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
  private restoring = false;
  private overlay = false; // when true, the active view is detached so a DOM overlay can show on top
  private simulatorActive = false; // when true, the simulator overlay window owns the pane area
  onChange?: () => void;

  /** Detach the WebContentsView pane while the serve-sim overlay window owns the area. */
  setSimulatorActive(on: boolean): void {
    this.simulatorActive = on;
    this.applyActive();
  }

  /** Target kind of the active pane (drives tool-layer capability gating). All
   * panes are web today; becomes meaningful once RN panes land (Phase 1 item 11). */
  get kind(): TargetKind {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    return p?.ctl.kind ?? "web";
  }

  /** Detach/re-attach the active pane view so renderer DOM (e.g. a lightbox) can cover the area. */
  setOverlay(on: boolean): void {
    this.overlay = on;
    this.applyActive();
  }

  constructor(
    private readonly buffer: LogBuffer,
    private readonly opts: ElectronBrowserOptions,
    private readonly offscreen: boolean,
    /** Paths so a popped-out pane can load the same renderer (in `?pop=<id>` mode) as its chrome. */
    private readonly popChrome: { indexPath: string; preloadPath: string },
  ) {
    // Per-pane auto-navigate: when a pane's dev server logs a localhost URL, open it there.
    buffer.onPush((e) => {
      if (e.source !== "server" || !e.target) return;
      const p = this.panes.get(e.target);
      if (!p?.awaitingUrl) return;
      const m = e.line.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i);
      if (m) {
        p.awaitingUrl = false;
        p.url = m[0];
        void p.ctl.navigate(m[0]);
        this.persist();
      }
    });
  }

  attachTo(shell: BrowserWindow): void {
    this.shell = shell;
  }

  async start(): Promise<void> {
    const saved = getPanes();
    this.restoring = true;
    try {
      if (saved.panes.length) {
        for (const s of saved.panes) {
          // Recreate the pane (blank), then decide what to display — without assuming the
          // dev server is running. A localhost URL gets a "press ▶ to start" placeholder.
          const info = await this.newPane(undefined, s.label, s.cmd, s.cwd);
          const p = this.panes.get(info.id)!;
          p.url = s.url || "about:blank"; // canonical (persisted) url, not the placeholder
          if (s.url && isLocalUrl(s.url)) await p.ctl.navigate(this.placeholder(s.label, s.url));
          else if (s.url) await p.ctl.navigate(s.url);
        }
        const ids = [...this.panes.keys()];
        const target = ids[saved.activeIndex ?? 0];
        if (target) {
          this.activeId = target;
          this.applyActive();
        }
      } else {
        await this.newPane();
      }
    } finally {
      this.restoring = false;
    }
    this.persist();
  }

  private placeholder(label: string | undefined, url: string): string {
    return (
      "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<html><body style="margin:0;font:14px ui-monospace,monospace;background:#0d1117;color:#8b949e;display:grid;place-items:center;height:100vh">` +
          `<div style="text-align:center"><div style="font-size:16px;color:#c9d1d9">${label ?? "dev server"}</div>` +
          `<div style="margin-top:8px">press ▶ to start — was ${url}</div></div></body></html>`,
      )
    );
  }

  private persist(): void {
    if (this.restoring) return;
    const ids = [...this.panes.keys()];
    setPanes({
      panes: ids.map((id) => {
        const p = this.panes.get(id)!;
        return { url: p.url, label: p.label, cmd: p.cmd, cwd: p.cwd };
      }),
      activeIndex: this.activeId ? ids.indexOf(this.activeId) : 0,
    });
  }

  private notify(): void {
    try {
      this.onChange?.();
    } catch {
      /* a destroyed window listener must not break teardown */
    }
    // Popped windows render their own browser bar — keep their URL/nav state fresh too.
    for (const p of this.panes.values()) {
      if (p.popped && !p.popped.isDestroyed()) {
        try {
          p.popped.webContents.send("devloop:panesChanged");
        } catch {
          /* window tearing down */
        }
      }
    }
  }

  private active(): ElectronBrowserController {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (!p) throw new Error("no active browser pane");
    return p.ctl;
  }

  private paneOrActive(id?: string): Pane {
    // Fall back to the active pane, then to any open pane (e.g. when the active one was popped).
    const key = id ?? this.activeId ?? this.panes.keys().next().value;
    const p = key ? this.panes.get(key) : undefined;
    if (!p) throw new Error("no panes open");
    return p;
  }

  /** Ensure there's an active pane (creating one if all were closed). */
  async ensureActive(): Promise<void> {
    if (this.activeId && this.panes.has(this.activeId)) return;
    const first = this.panes.keys().next().value;
    if (first) this.activeId = first;
    else await this.newPane();
  }

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
    if (this.overlay || this.simulatorActive) return; // keep the area clear for a DOM overlay / simulator window
    const a = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (a && !a.popped) {
      this.shell.contentView.addChildView(a.view);
      a.view.setBounds(this.bounds);
    }
  }

  setBounds(rect: Rect): void {
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    if (this.overlay) return;
    const a = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (a && !a.popped && this.shell && !this.shell.isDestroyed()) a.view.setBounds(this.bounds);
  }

  // --- pane management ---
  async newPane(url?: string, label?: string, cmd?: string, cwd?: string): Promise<PaneInfo> {
    const id = `pane-${++this.counter}`;
    const view = new WebContentsView({ webPreferences: { partition: PANE_PARTITION, sandbox: false, offscreen: this.offscreen } });
    await view.webContents.loadURL("about:blank");
    const ctl = new ElectronBrowserController(this.buffer, view.webContents, this.opts, id);
    await ctl.start();
    const pane: Pane = { id, view, ctl, dev: new DevServer(this.buffer, id), cmd, cwd, label, url: url ?? "about:blank" };
    this.panes.set(id, pane);
    // Track the live URL (link clicks, SPA routes) for the address bar — but ignore
    // placeholder/blank pages so the canonical (persisted) url isn't clobbered.
    const sync = (u: string) => {
      if (u.startsWith("data:") || u === "about:blank") return;
      pane.url = u;
      this.persist();
      this.notify();
    };
    view.webContents.on("did-navigate", (_e, u) => sync(u));
    view.webContents.on("did-navigate-in-page", (_e, u, isMainFrame) => isMainFrame && sync(u));
    this.activeId = id;
    this.applyActive();
    if (url) await ctl.navigate(url);
    this.persist();
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
    this.persist();
    this.notify();
    return this.info(id);
  }

  closePane(id: string): boolean {
    const p = this.panes.get(id);
    if (!p) return false;
    p.dev.stop();
    void p.ctl.close();
    if (p.popped && !p.popped.isDestroyed()) {
      const w = p.popped;
      p.popped = undefined; // so the 'close'/dockPane path no-ops — we're destroying the pane
      w.destroy();
    } else if (this.shell && !this.shell.isDestroyed()) {
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
    // Zero panes is a valid state (browser-area hint shows); a dev action re-creates one.
    this.persist();
    this.notify();
    return true;
  }

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
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      show: !this.offscreen,
      title: `Devloop — ${p.label ?? id}`,
      webPreferences: { preload: this.popChrome.preloadPath, contextIsolation: true, sandbox: false, offscreen: this.offscreen },
    });
    win.contentView.addChildView(p.view);
    // Initial bounds (leave room for the bar); the pop renderer refines via setBoundsFor once mounted.
    const [w, h] = win.getContentSize();
    p.view.setBounds({ x: 0, y: 44, width: w, height: Math.max(0, h - 44) });
    // Closing the pop-out RE-DOCKS the pane (doesn't destroy it). The tab's × still closes it
    // — closePane uses win.destroy(), which skips 'close', so this handler won't re-dock then.
    win.on("close", () => this.dockPane(id));
    p.popped = win;
    // Load the same renderer in pop mode — its own browser bar drives this pane.
    void win.loadFile(this.popChrome.indexPath, { search: `pop=${id}` });
    // The popped pane stays ACTIVE (just external) — so its config still shows in the controls
    // and closing the window re-docks it. The shell area just clears while it's out.
    this.applyActive();
    this.persist();
    this.notify();
    return this.info(id);
  }

  // --- per-pane dev lifecycle (default: active pane) ---
  setDevConfig(id: string | undefined, cmd: string | undefined, cwd: string | undefined): void {
    const p = this.paneOrActive(id);
    p.cmd = cmd;
    p.cwd = cwd;
    this.persist();
    this.notify();
  }

  devStart(id?: string, cmd?: string, cwd?: string): DevStatus {
    const p = this.paneOrActive(id);
    if (cmd !== undefined) p.cmd = cmd;
    if (cwd !== undefined) p.cwd = cwd;
    const resolvedCwd = p.cwd || process.cwd();
    const resolvedCmd = p.cmd || detectDevCommand(resolvedCwd);
    p.awaitingUrl = true; // auto-navigate this pane when the server announces its URL
    const st = p.dev.start(resolvedCmd, resolvedCwd);
    this.persist();
    this.notify();
    return st;
  }

  devStop(id?: string): boolean {
    const r = this.paneOrActive(id).dev.stop();
    this.notify();
    return r;
  }

  devRestart(id?: string): DevStatus {
    const p = this.paneOrActive(id);
    p.dev.stop();
    return this.devStart(p.id);
  }

  devStatus(id?: string): DevStatus {
    if (this.panes.size === 0) return { running: false };
    return this.paneOrActive(id).dev.status();
  }

  reload(id: string | undefined, hard: boolean): void {
    if (this.panes.size === 0) return;
    const wc = this.paneOrActive(id).view.webContents;
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  /** Test hook: force the active pane's renderer to crash (verifies self-heal). */
  __crashActive(): void {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    p?.view.webContents.forcefullyCrashRenderer();
  }

  /** Test hook: user-close a popped window (verifies re-dock). */
  __closePoppedWindow(id: string): void {
    this.panes.get(id)?.popped?.close();
  }

  /** Re-dock a popped pane back into the shell (called when its window is closed). */
  private dockPane(id: string): void {
    const p = this.panes.get(id);
    if (!p?.popped) return;
    try {
      p.popped.contentView.removeChildView(p.view); // keep the view alive as the window closes
    } catch {
      /* already detached */
    }
    p.popped = undefined;
    if (this.activeId === id) this.applyActive(); // re-attach + position in the shell
    this.persist();
    this.notify();
  }

  private info(id: string): PaneInfo {
    const p = this.panes.get(id)!;
    const st = p.dev.status();
    let nav = { canBack: false, canForward: false };
    try {
      nav = { canBack: p.view.webContents.navigationHistory.canGoBack(), canForward: p.view.webContents.navigationHistory.canGoForward() };
    } catch {
      /* view gone */
    }
    return {
      id,
      url: p.url,
      active: id === this.activeId,
      popped: !!p.popped,
      label: p.label,
      dev: { running: st.running, name: st.name, cmd: p.cmd, cwd: p.cwd, exitCode: st.exitCode },
      nav,
    };
  }

  setLabel(id: string, label: string): void {
    const p = this.panes.get(id);
    if (!p) return;
    p.label = label;
    this.persist();
    this.notify();
  }

  // --- IBrowserController (delegate to active pane) ---
  async navigate(url: string) {
    const r = await this.active().navigate(url);
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (p && !url.startsWith("data:") && url !== "about:blank") p.url = url; // canonical url
    this.persist();
    return r;
  }

  back(): void {
    if (this.panes.size === 0) return;
    const wc = this.paneOrActive().view.webContents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }
  forward(): void {
    if (this.panes.size === 0) return;
    const wc = this.paneOrActive().view.webContents;
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  // --- pane-targeted ops (a popped window drives its own pane by id) ---
  async navigateFor(id: string, url: string) {
    const p = this.panes.get(id);
    if (!p) return { url, status: null };
    const r = await p.ctl.navigate(url);
    if (!url.startsWith("data:") && url !== "about:blank") p.url = url;
    this.persist();
    return r;
  }
  backFor(id: string): void {
    const wc = this.panes.get(id)?.view.webContents;
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }
  forwardFor(id: string): void {
    const wc = this.panes.get(id)?.view.webContents;
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }
  setBoundsFor(id: string, rect: Rect): void {
    const p = this.panes.get(id);
    if (!p || !p.popped) return; // only meaningful while popped
    p.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  }
  screenshotFor(id: string): Promise<{ base64: string; mimeType: string }> {
    const p = this.panes.get(id);
    if (!p) return Promise.resolve({ base64: "", mimeType: "image/png" });
    return p.ctl.screenshot(false);
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
  hover(selector: string) {
    return this.active().hover(selector);
  }
  scroll(opts: { selector?: string; x?: number; y?: number }) {
    return this.active().scroll(opts);
  }
  select(selector: string, value: string) {
    return this.active().select(selector, value);
  }
  press(key: string, selector?: string) {
    return this.active().press(key, selector);
  }
  evaluate(expression: string) {
    return this.active().evaluate(expression);
  }
  snapshot() {
    return this.active().snapshot();
  }
  pick() {
    return this.active().pick();
  }
  clearStorage(opts?: { allOrigins?: boolean }) {
    return this.active().clearStorage(opts);
  }
  emulate(opts: { device?: string; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string; reset?: boolean }) {
    return this.active().emulate(opts);
  }
  throttle(profile: string) {
    return this.active().throttle(profile);
  }
  waitFor(opts: { selector?: string; text?: string; timeoutMs?: number }) {
    return this.active().waitFor(opts);
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
        p.dev.stop();
      } catch {
        /* ignore */
      }
      try {
        await p.ctl.close();
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
