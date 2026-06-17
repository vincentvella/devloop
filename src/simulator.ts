/**
 * Pure logic for the simulator view (serve-sim). The simulator can't live in a
 * child WebContentsView — Electron won't composite serve-sim's high-rate 2D
 * canvas into a child view (it paints but never presents). A top-level
 * BrowserWindow composites it fine, so we use a frameless child BrowserWindow
 * positioned *over* the pane region: it looks embedded but is a real window.
 *
 * This module holds the pure decisions (when to show it, where to put it, how to
 * launch serve-sim); the Electron window lives in cockpit/simulatorWindow.ts.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SimVisibilityState {
  /** The simulator is the active view (its tab/pane is selected). */
  isActiveView: boolean;
  /** A DOM overlay (settings modal / lightbox) is open over the pane area. */
  overlayOpen: boolean;
  /** The cockpit shell window is shown (not minimized/hidden). */
  windowVisible: boolean;
}

/**
 * The child window floats ABOVE the cockpit renderer, so it must hide whenever
 * the renderer needs to draw over the pane area — same contract the
 * WebContentsView panes already follow via the overlay mechanism.
 */
export function shouldShowSimulator(s: SimVisibilityState): boolean {
  return s.isActiveView && !s.overlayOpen && s.windowVisible;
}

/**
 * Screen-space bounds for the child window. The pane rect is in the shell
 * window's content coordinates (what the renderer reports); offset it by the
 * content area's screen origin. Clamped to a sane minimum so a zero/négative
 * rect (e.g. during layout) never throws.
 */
export function simulatorBounds(contentBounds: Rect, paneRect: Rect): Rect {
  return {
    x: Math.round(contentBounds.x + paneRect.x),
    y: Math.round(contentBounds.y + paneRect.y),
    width: Math.max(1, Math.round(paneRect.width)),
    height: Math.max(1, Math.round(paneRect.height)),
  };
}

export const SERVE_SIM_PORT = 3200;
export const SERVE_SIM_URL = `http://localhost:${SERVE_SIM_PORT}/`;
/** serve-sim exposes the booted device's MJPEG stream URL here. */
export const SERVE_SIM_API = `http://localhost:${SERVE_SIM_PORT}/api`;

/**
 * A minimal viewer page: just the device's MJPEG stream as an <img>, fit to the
 * pane. An <img> composites in a WebContentsView (serve-sim's GPU canvas does
 * not), so this renders cleanly embedded in the pane — no separate window.
 * Returns a data: URL.
 */
export function simulatorViewerHtml(streamUrl: string): string {
  const html =
    `<!doctype html><html><body style="margin:0;background:#000;display:grid;place-items:center;height:100vh;overflow:hidden">` +
    `<img src="${streamUrl}" style="max-width:100%;max-height:100vh;object-fit:contain" alt="iOS simulator">` +
    `</body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

/** Pull the booted device's MJPEG stream URL out of serve-sim's /api payload. */
export function streamUrlFromApi(api: { streamUrl?: string } | null | undefined): string | null {
  return api?.streamUrl && /^https?:\/\//.test(api.streamUrl) ? api.streamUrl : null;
}

/** How to launch serve-sim (bun-first, per project convention). */
export function serveSimSpawn(): { cmd: string; args: string[] } {
  return { cmd: "bunx", args: ["serve-sim", "--port", String(SERVE_SIM_PORT)] };
}
