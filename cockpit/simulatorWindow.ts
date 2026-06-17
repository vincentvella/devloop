/**
 * The simulator view: a frameless child BrowserWindow overlaying the cockpit's
 * pane region, showing serve-sim (a live, interactive iOS-simulator mirror).
 *
 * It's a real top-level window (so it composites serve-sim's canvas, which a
 * child WebContentsView can't) parented to the shell and positioned over the
 * pane area. Because it floats above the renderer, it hides whenever a DOM
 * overlay is up — same contract the WebContentsView panes follow. Pure decisions
 * (shouldShow / bounds / spawn) live in src/simulator.ts.
 */
import { BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import {
  shouldShowSimulator,
  simulatorBounds,
  serveSimSpawn,
  SERVE_SIM_URL,
  type Rect,
  type SimVisibilityState,
} from "../src/simulator.ts";

export class SimulatorWindow {
  private win?: BrowserWindow;
  private proc?: ChildProcess;
  private state: SimVisibilityState = { isActiveView: false, overlayOpen: false, windowVisible: true };
  private paneRect: Rect = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    private readonly parent: BrowserWindow,
    /** Screen-space content bounds of the shell window (parent.getContentBounds). */
    private readonly contentBounds: () => Rect,
    private readonly log: (m: string) => void,
  ) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  /** Launch serve-sim (if needed), create the overlay window, and show it. */
  async open(paneRect: Rect): Promise<void> {
    this.paneRect = paneRect;
    await this.ensureServeSim();
    if (!this.isOpen) {
      this.win = new BrowserWindow({
        parent: this.parent,
        frame: false,
        resizable: false,
        show: false,
        webPreferences: { contextIsolation: true },
      });
      this.win.on("closed", () => (this.win = undefined));
      await this.win.loadURL(SERVE_SIM_URL);
    }
    this.state.isActiveView = true;
    this.apply();
  }

  setActiveView(active: boolean): void {
    this.state.isActiveView = active;
    this.apply();
  }
  setOverlay(open: boolean): void {
    this.state.overlayOpen = open;
    this.apply();
  }
  setWindowVisible(visible: boolean): void {
    this.state.windowVisible = visible;
    this.apply();
  }
  setPaneRect(rect: Rect): void {
    this.paneRect = rect;
    this.reposition();
  }

  /** Apply the show/hide decision + keep bounds in sync. */
  private apply(): void {
    if (!this.isOpen) return;
    if (shouldShowSimulator(this.state)) {
      this.reposition();
      this.win!.showInactive(); // never steal focus from the cockpit
    } else {
      this.win!.hide();
    }
  }

  private reposition(): void {
    if (!this.isOpen) return;
    this.win!.setBounds(simulatorBounds(this.contentBounds(), this.paneRect));
  }

  /** Spawn serve-sim and wait until it answers, so loadURL doesn't hit a dead port. */
  private async ensureServeSim(): Promise<void> {
    if (await this.serveSimUp()) return;
    if (!this.proc || this.proc.killed) {
      const { cmd, args } = serveSimSpawn();
      this.log(`simulator: starting serve-sim (${cmd} ${args.join(" ")})`);
      this.proc = spawn(cmd, args, { stdio: "ignore" });
      this.proc.on("exit", (code) => this.log(`simulator: serve-sim exited (${code})`));
    }
    for (let i = 0; i < 40; i++) {
      if (await this.serveSimUp()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.log("simulator: serve-sim did not become ready in time");
  }

  private async serveSimUp(): Promise<boolean> {
    try {
      const res = await fetch(SERVE_SIM_URL, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.isOpen) this.win!.close();
    this.win = undefined;
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.proc = undefined;
  }
}
