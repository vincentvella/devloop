/**
 * The browser substrate contract. Both the Puppeteer-driven Chrome (headless
 * stdio mode) and the Electron `webContents` (cockpit mode) implement this, so
 * the MCP tool layer is agnostic to which one is behind it.
 */
export interface IBrowserController {
  start(): Promise<void>;
  navigate(url: string): Promise<{ url: string; status: number | null }>;
  screenshot(fullPage?: boolean): Promise<{ base64: string; mimeType: string }>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  waitForNetworkIdle(idleMs?: number, timeoutMs?: number): Promise<void>;
  currentUrl(): string;
  close(): Promise<void>;
}

export interface PaneInfo {
  id: string;
  url: string;
  active: boolean;
  /** True when the pane has been detached into its own window. */
  popped?: boolean;
  /** Display label (e.g. the project name) shown on the tab. */
  label?: string;
  /** This pane's dev server state (per-pane mode). */
  dev?: { running: boolean; name?: string; cmd?: string; cwd?: string; exitCode?: number | null };
}

/**
 * Multi-target manager: a controller that owns several browser panes and
 * delegates the IBrowserController methods to the active one. The cockpit
 * implements this; the stdio (Puppeteer) controller is effectively single-pane.
 */
export interface IBrowserManager extends IBrowserController {
  listPanes(): PaneInfo[];
  newPane(url?: string): Promise<PaneInfo>;
  selectPane(id: string): PaneInfo;
  closePane(id: string): boolean;
  popPane(id: string): PaneInfo;
}
