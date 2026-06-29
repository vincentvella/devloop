/**
 * Shared mocks for handleTool() integration tests. Builds a full IBrowserManager
 * stub (every method tracked via bun's mock()), a DevServerLike stub, and wires
 * them through configureTools so a test can call handleTool("tool", args) and
 * assert on both the JSON result and the calls made to the mocks.
 */
import { mock } from "bun:test";
import { LogBuffer } from "../src/logBuffer.ts";
import { configureTools, type ToolDeps } from "../src/toolLayer.ts";

/** Parse the JSON text result of a tool call. */
export function parse(r: { content: { type: string; text?: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

// biome-ignore lint/suspicious/noExplicitAny: test mocks are intentionally loose
type Any = any;

/** A fully-stubbed browser that also implements the multi-pane manager surface. */
export function makeBrowser(over: Record<string, Any> = {}): Any {
  return {
    kind: "web",
    start: mock(async () => {}),
    navigate: mock(async (url: string) => ({ url, status: 200 })),
    back: mock(async () => {}),
    forward: mock(async () => {}),
    reload: mock(async () => {}),
    screenshot: mock(async () => ({ base64: "QUFB", mimeType: "image/png" })),
    click: mock(async () => {}),
    type: mock(async () => {}),
    hover: mock(async () => {}),
    scroll: mock(async () => {}),
    select: mock(async () => {}),
    press: mock(async () => {}),
    evaluate: mock(async () => 42),
    snapshot: mock(async () => ({ url: "http://x/", title: "T", elements: [] })),
    waitFor: mock(async () => ({ ok: true, waitedMs: 5 })),
    clearStorage: mock(async () => {}),
    emulate: mock(async () => {}),
    throttle: mock(async () => {}),
    waitForNetworkIdle: mock(async () => {}),
    currentUrl: mock(() => "http://x/"),
    close: mock(async () => {}),
    // IBrowserManager surface
    listPanes: mock(() => [{ id: "p1", url: "http://x/", active: true, label: "Web" }]),
    newPane: mock(async (url?: string) => ({ id: "p2", url: url ?? "about:blank", active: true })),
    selectPane: mock((id: string) => ({ id, url: "http://x/", active: true })),
    closePane: mock(() => true),
    popPane: mock((id: string) => ({ id, url: "http://x/", active: true, popped: true })),
    setLabel: mock(() => {}),
    ...over,
  };
}

export function makeDevServer(over: Record<string, Any> = {}): Any {
  return {
    start: mock(async () => ({ running: true, cmd: "bun run dev", cwd: "/proj", pid: 123 })),
    stop: mock(() => true),
    status: mock(() => ({ running: false })),
    ...over,
  };
}

/** Wire mocks through configureTools; returns the handles so tests can assert calls. */
export function configure(
  opts: { browser?: Any; devServer?: Any; buffer?: LogBuffer; nativeControl?: Any; extControl?: Any } = {},
): { browser: Any; devServer: Any; buffer: LogBuffer } {
  const buffer = opts.buffer ?? new LogBuffer(100);
  const browser = opts.browser ?? makeBrowser();
  const devServer = opts.devServer ?? makeDevServer();
  configureTools({
    buffer,
    browser,
    devServer,
    ...(opts.nativeControl ? { nativeControl: opts.nativeControl } : {}),
    ...(opts.extControl ? { extControl: opts.extControl } : {}),
  } as unknown as ToolDeps);
  return { browser, devServer, buffer };
}
