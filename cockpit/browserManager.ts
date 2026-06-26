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
import type { IBrowserController, IBrowserManager, PaneInfo } from "../src/browserController.ts";
import type { TargetKind } from "../src/target.ts";
import { SERVE_SIM_URL, type SimInfo } from "../src/simulator.ts";
import { getPanes, setPanes } from "../src/registry.ts";
import { DevServer, detectDevCommand, type DevStatus } from "../src/devServer.ts";
import { partitionForCwd, DEFAULT_PARTITION } from "../src/partition.ts";

/** Default session for panes with no project bound — separate from the shell's default
 *  session so loaded extensions never inject into the cockpit UI itself. Panes bound to a
 *  project get their own per-project partition (#27) via partitionForCwd. */
export const PANE_PARTITION = DEFAULT_PARTITION;
import { ElectronBrowserController, type ElectronBrowserOptions } from "../src/electronBrowser.ts";

interface Pane {
  id: string;
  view: WebContentsView;
  ctl: ElectronBrowserController;
  /** RN/idb controller for this pane's native (iOS) target; browser_* route here
   *  while the simulator target is active. Set when native observability attaches. */
  nativeCtl?: IBrowserController;
  dev: DevServer; // this pane's own dev server
  cmd?: string;
  cwd?: string;
  label?: string;
  url: string; // canonical URL (persisted) — may differ from what's displayed (e.g. a placeholder)
  partition: string; // the pane's session partition (per-project, #27); recreated on change
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
  private simulatorActive = false; // when true, the serve-sim view owns the pane area (iOS)
  private androidActive = false; // when true, browser_* route to adb + the renderer shows the mirror
  private simView?: WebContentsView; // serve-sim MJPEG stream viewer (created on first use)
  onChange?: () => void;

  /**
   * Show/hide the simulator over the pane area. The simulator is a SECOND
   * WebContentsView (not a child OS window — so no Launchpad/Mission Control
   * artifacts) showing serve-sim's raw MJPEG stream as an <img> (which composites
   * in a WebContentsView; serve-sim's GPU canvas does not). It rides the same
   * bounds/overlay logic as the panes.
   */
  async setSimulatorActive(on: boolean, info?: SimInfo): Promise<void> {
    this.simulatorActive = on;
    if (on && info && !this.simView) {
      // Dedicated session (no extensions/web-store). The preload nulls VideoDecoder
      // (→ serve-sim's MJPEG <img>, which composites; avcc <canvas> does not) and
      // sets __SIM_PREVIEW__ from these args (→ interactive preview, no chrome).
      this.simView = new WebContentsView({
        webPreferences: {
          partition: "persist:devloop-sim",
          offscreen: this.offscreen,
          contextIsolation: false, // preload shares the page world to set serve-sim's globals
          preload: this.popChrome.simPreloadPath,
          additionalArguments: [`--sim-device=${info.device}`, `--sim-url=${info.url}`],
        },
      });
      await this.simView.webContents.loadURL(SERVE_SIM_URL);
    }
    this.applyActive();
  }

  /** Target kind of the active target (drives tool-layer capability gating) — the
   * native (react-native) controller when the iOS simulator target is active, else web. */
  get kind(): TargetKind {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (!p) return "web";
    return this.nativeRouted && p.nativeCtl ? p.nativeCtl.kind : p.ctl.kind;
  }

  /** A native target (iOS sim or Android device) owns browser_* for the active pane. */
  private get nativeRouted(): boolean {
    return this.simulatorActive || this.androidActive;
  }

  /** Activate/deactivate Android routing — the mirror renders as renderer DOM, so the
   *  pane area is cleared like an overlay (no second WebContentsView). */
  setAndroidActive(on: boolean): void {
    this.androidActive = on;
    this.applyActive();
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
    /** Paths so a popped-out pane can load the same renderer (in `?pop=<id>` mode) as its chrome,
     * plus the simulator-view preload (serve-sim preview/mjpeg shim). */
    private readonly popChrome: { indexPath: string; preloadPath: string; simPreloadPath: string },
    /** Prepare a session partition (load extensions into it) before a view uses it (#27). */
    private readonly prepareSession?: (partition: string) => Promise<void>,
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
        `<html><body style="margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0d1117;color:#8b949e;display:grid;place-items:center;height:100vh">` +
          `<div style="text-align:center;max-width:420px;padding:24px">` +
          `<div style="font-size:40px;line-height:1">▶</div>` +
          `<div style="font-size:20px;color:#c9d1d9;margin-top:14px;font-weight:600">${label ?? "dev server"} isn't running</div>` +
          `<div style="margin-top:10px;font-size:14px">Press <b style="color:#c9d1d9">▶</b> in the timeline header to start the dev server / bundler.</div>` +
          `<div style="margin-top:8px;font-size:12px;opacity:0.6">${url}</div>` +
          `</div></body></html>`,
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

  /** The controller browser_* tools act on: the native (RN/idb) controller when the
   *  iOS simulator target is active for this pane, else the pane's web controller. */
  private routed(): IBrowserController {
    const p = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (!p) throw new Error("no active browser pane");
    return this.nativeRouted && p.nativeCtl ? p.nativeCtl : p.ctl;
  }

  /** Register (or clear) a pane's native controller — wired when observability attaches. */
  setNativeController(paneId: string, ctl: IBrowserController | undefined): void {
    const p = this.panes.get(paneId);
    if (p) p.nativeCtl = ctl;
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
    if (this.simView) {
      try {
        this.shell.contentView.removeChildView(this.simView);
      } catch {
        /* not attached */
      }
    }
    if (this.overlay || this.androidActive) return; // keep the area clear for a DOM overlay (modal/lightbox, Android mirror)
    if (this.simulatorActive && this.simView) {
      this.shell.contentView.addChildView(this.simView);
      this.simView.setBounds(this.bounds);
      return;
    }
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
    if (this.overlay || this.androidActive) return;
    if (this.simulatorActive && this.simView && this.shell && !this.shell.isDestroyed()) {
      this.simView.setBounds(this.bounds);
      return;
    }
    const a = this.activeId ? this.panes.get(this.activeId) : undefined;
    if (a && !a.popped && this.shell && !this.shell.isDestroyed()) a.view.setBounds(this.bounds);
  }

  // --- pane management ---
  /** Create a WebContentsView + controller on a prepared partition, and wire address-bar
   *  URL tracking onto the given pane. Shared by newPane + recreateView (#27). */
  private async createView(pane: Pane, partition: string): Promise<{ view: WebContentsView; ctl: ElectronBrowserController }> {
    await this.prepareSession?.(partition); // load extensions into this session first
    const view = new WebContentsView({ webPreferences: { partition, sandbox: false, offscreen: this.offscreen } });
    await view.webContents.loadURL("about:blank");
    const ctl = new ElectronBrowserController(this.buffer, view.webContents, this.opts, pane.id);
    await ctl.start();
    // Track the live URL (link clicks, SPA routes) — but ignore placeholder/blank pages
    // so the canonical (persisted) url isn't clobbered.
    const sync = (u: string) => {
      if (u.startsWith("data:") || u === "about:blank") return;
      pane.url = u;
      this.persist();
      this.notify();
    };
    view.webContents.on("did-navigate", (_e, u) => sync(u));
    view.webContents.on("did-navigate-in-page", (_e, u, isMainFrame) => isMainFrame && sync(u));
    return { view, ctl };
  }

  async newPane(url?: string, label?: string, cmd?: string, cwd?: string): Promise<PaneInfo> {
    const id = `pane-${++this.counter}`;
    const partition = partitionForCwd(cwd);
    const pane: Pane = { id, view: undefined as unknown as WebContentsView, ctl: undefined as unknown as ElectronBrowserController, dev: new DevServer(this.buffer, id), cmd, cwd, label, url: url ?? "about:blank", partition };
    const { view, ctl } = await this.createView(pane, partition);
    pane.view = view;
    pane.ctl = ctl;
    this.panes.set(id, pane);
    this.activeId = id;
    this.applyActive();
    if (url) await ctl.navigate(url);
    this.persist();
    this.notify();
    return this.info(id);
  }

  /**
   * Recreate a pane's view on a new partition (#27 — Electron partitions are immutable
   * per view, so changing a pane's project means a fresh view). Preserves the canonical
   * URL; tears down the old view/controller after swapping in the new one.
   */
  private async recreateView(pane: Pane, partition: string): Promise<void> {
    if (pane.popped) return; // a popped pane owns its own window; leave it
    const old = { view: pane.view, ctl: pane.ctl };
    const { view, ctl } = await this.createView(pane, partition);
    pane.view = view;
    pane.ctl = ctl;
    pane.partition = partition;
    if (this.activeId === pane.id) this.applyActive(); // swaps the new view in (removes the old)
    const dest = pane.url && pane.url !== "about:blank" ? pane.url : undefined;
    if (dest) await ctl.navigate(isLocalUrl(dest) ? this.placeholder(pane.label, dest) : dest);
    try {
      if (this.shell && !this.shell.isDestroyed()) this.shell.contentView.removeChildView(old.view);
    } catch {
      /* not attached */
    }
    void old.ctl.close().catch(() => {});
    try {
      old.view.webContents.close();
    } catch {
      /* already gone */
    }
  }

  /** If a pane's project cwd now maps to a different partition, recreate its view (#27). */
  private async ensurePaneSession(pane: Pane): Promise<void> {
    const want = partitionForCwd(pane.cwd);
    if (want !== pane.partition) await this.recreateView(pane, want);
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
  async setDevConfig(id: string | undefined, cmd: string | undefined, cwd: string | undefined): Promise<void> {
    const p = this.paneOrActive(id);
    p.cmd = cmd;
    p.cwd = cwd;
    await this.ensurePaneSession(p); // isolate storage per project (#27)
    this.persist();
    this.notify();
  }

  async devStart(id?: string, cmd?: string, cwd?: string): Promise<DevStatus> {
    const p = this.paneOrActive(id);
    if (cmd !== undefined) p.cmd = cmd;
    if (cwd !== undefined) p.cwd = cwd;
    await this.ensurePaneSession(p); // a project's cwd drives its session partition (#27)
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

  devRestart(id?: string): Promise<DevStatus> {
    const p = this.paneOrActive(id);
    p.dev.stop();
    return this.devStart(p.id);
  }

  devStatus(id?: string): DevStatus {
    if (this.panes.size === 0) return { running: false };
    return this.paneOrActive(id).dev.status();
  }

  reload(hard = false): void {
    if (this.panes.size === 0) return;
    const wc = this.paneOrActive().view.webContents;
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  reloadFor(id: string, hard = false): void {
    const wc = this.panes.get(id)?.view.webContents;
    if (!wc) return;
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
  // browser_* delegate to routed() — the native (idb) controller when the iOS target
  // is active, else the web pane. (Tools unsupported on the active kind are blocked
  // upstream by capability gating, so e.g. emulate never reaches a native target.)
  screenshot(fullPage?: boolean) {
    return this.routed().screenshot(fullPage);
  }
  click(selector: string) {
    return this.routed().click(selector);
  }
  type(selector: string, text: string) {
    return this.routed().type(selector, text);
  }
  hover(selector: string) {
    return this.routed().hover(selector);
  }
  scroll(opts: { selector?: string; x?: number; y?: number }) {
    return this.routed().scroll(opts);
  }
  select(selector: string, value: string) {
    return this.routed().select(selector, value);
  }
  press(key: string, selector?: string) {
    return this.routed().press(key, selector);
  }
  evaluate(expression: string) {
    return this.routed().evaluate(expression);
  }
  snapshot() {
    return this.routed().snapshot();
  }
  pick() {
    return this.active().pick(); // web-only element picker (DOM overlay)
  }
  clearStorage(opts?: { allOrigins?: boolean }) {
    return this.routed().clearStorage(opts);
  }
  emulate(opts: { device?: string; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string; reset?: boolean }) {
    return this.routed().emulate(opts);
  }
  throttle(profile: string) {
    return this.routed().throttle(profile);
  }
  waitFor(opts: { selector?: string; text?: string; timeoutMs?: number }) {
    return this.routed().waitFor(opts);
  }
  waitForNetworkIdle(idleMs?: number, timeoutMs?: number) {
    return this.routed().waitForNetworkIdle(idleMs, timeoutMs);
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
