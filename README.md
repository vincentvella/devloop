# devloop-mcp

A unified dev-loop tool: it drives a **browser** and your **dev server**, pushing both sides into one timestamped buffer so you can correlate a browser console error with the backend stack trace from the same moment. It runs two ways from a shared core:

- **Headless (stdio)** — drives Chrome via Puppeteer, served over stdio. The lightweight mode Claude Code spawns per session.
- **Cockpit (Electron)** — a desktop app whose windows *are* the browser (embedded panes driven via CDP), with a live timeline UI, a project picker, multi-pane targets, and a visual repro builder. Serves the same tools over HTTP.

Because every event (browser console/network/page-errors **and** server stdout/stderr) shares one monotonic clock, `get_logs_around` / `repro` return a correlated, cross-source slice of the timeline.

## Architecture

```
            ┌──────────────────────── shared core (src/) ────────────────────────┐
            │  logBuffer · devServer · registry · toolLayer (TOOLS + handleTool)  │
            └────────────────────────────────────────────────────────────────────┘
                         ▲                                   ▲
   IBrowserController ───┤                                   ├─── IBrowserManager
                         │                                   │
   Puppeteer (Chrome) ◀──┘                                   └──▶ Electron webContents (N panes)
                         │                                   │
   stdio  ◀── index.ts ──┘                                   └── cockpit/main.ts ──▶ MCP over HTTP
   (Claude spawns)                                              (long-running app; Claude connects to a URL)
```

The **tool layer is transport- and substrate-agnostic**: it's bound to `{ buffer, browser, devServer }` via `configureTools()` and never knows whether Puppeteer or Electron is behind it, or whether it's talking over stdio or HTTP. The browser sits behind `IBrowserController`; the cockpit's `BrowserManager` implements the extended `IBrowserManager` (multiple panes, delegating to the active one).

stdout is reserved for the MCP protocol in stdio mode; all human-facing output goes to stderr.

## Install

```sh
bun install
bunx puppeteer browsers install chrome   # headless mode, if no bundled Chromium
# Electron's binary downloads on install; the cockpit needs it.
```

## Tools (19)

**Dev server** — runtime, no per-project registration needed
- `dev_start({ project?, cmd?, cwd? })` — start a dev server and tee its logs. Specify it three ways: a saved registry `project`; explicit `cmd`+`cwd`; or neither (`cwd` defaults to the server's dir, `cmd` auto-detected from `package.json` scripts: `dev`/`develop`/`web`/`start`/`serve`).
- `dev_stop()` — stop it. Kills the whole **process group** (so `next dev`/`metro` grandchildren die too).
- `dev_status()` — running?, plus cmd/cwd/pid.

**Browser control** — act on the active pane
- `browser_navigate({ url })`
- `browser_screenshot({ fullPage? })` → PNG image
- `browser_click({ selector })`
- `browser_type({ selector, text })`
- `browser_eval({ expression })` — runs in page context (not blocked by CSP)

**Logs & correlation**
- `get_logs({ source?, stream?, grep?, sinceSeq?, limit? })` — unified tail. `source` is `server`|`browser`; `stream` is `stdout`/`stderr`/`console`/`network`/`pageerror`. Pass the last `seq` as `sinceSeq` to tail incrementally.
- `get_logs_around({ ts, windowMs?, source? })` — **the correlation tool**: all events within ±`windowMs` of a timestamp, time-ordered across both sources.
- `clear_logs()` — reset before reproducing an issue.
- `repro({ actions | action, waitFor?, settleMs?, stepSettleMs?, idleMs?, timeoutMs?, continueOnError?, clear? })` — **reproduce-and-correlate**: clears the buffer, performs one action or a **sequence**, waits, and returns everything that happened on both sides across the sequence — with per-step results (`steps[]`), a `byStream` count, and a pre-filtered `errors` list.
  - `actions: [{kind, ...}]` — kinds: `navigate`/`click`/`type`/`eval`/`none`. `action` (singular) = one-step convenience.
  - Waits `stepSettleMs` (default 300) between steps, `settleMs` (default 1000) after the last. `waitFor: "networkidle"` waits until no network activity for `idleMs` (default 500) up to `timeoutMs` (default 10000) — **use it for slow/streaming responses** (Expo's first web bundle takes ~12s). On timeout you still get what landed, with a `waitNote`.
  - `continueOnError` (default false) — otherwise stops at the failing step (`stoppedAtStep`).

**Project registry** — saved projects, persisted to `~/.devloop/projects.json`
- `project_list()` — list saved projects (name, cwd, cmd, url).
- `project_add({ name, cwd, cmd?, url? })` — save/replace a project, so you can `dev_start({ project })` by name.
- `project_remove({ name })`.

**Panes** — multi-target (cockpit only; stdio mode is single-pane and reports so)
- `pane_list()` — each pane: `{ id, url, active }`. The active pane is what `browser_*`/`repro` target; events are tagged with their pane `id`.
- `pane_new({ url? })` — open a new pane and make it active.
- `pane_select({ id })` — make a pane active.
- `pane_close({ id })`.

### Console arguments

`console.log(obj)` is captured with arguments resolved to real values (e.g. `[log] user {"id":7}`), not `JSHandle@object`. The Electron substrate renders them synchronously from CDP previews; the Puppeteer substrate uses a *reserve-then-fill* pattern (stamp `seq`/`ts` synchronously at arrival, patch resolved args in afterward) so ordering matches emit order and interleaves correctly with server logs.

## Headless mode (stdio)

Register **once**, at user scope — works for every project:

```sh
claude mcp add devloop --scope user \
  -- bun run /Users/vince/Workspace/devloop-mcp/src/index.ts
```

Then, in any project: *"dev_start and repro a navigate to /projects"*. `dev_start` defaults `cwd` to the project you're in and auto-detects the command.

| Var | Default | Meaning |
| --- | --- | --- |
| `DEVLOOP_HEADLESS` | `false` | `"true"` runs Chrome headless; default headful so you can watch. |
| `DEVLOOP_CHROME_PATH` | _(bundled)_ | Explicit Chrome executable path. |
| `DEVLOOP_NET_THRESHOLD` | `400` | Log network responses with status >= this (failures always logged). |
| `DEVLOOP_ACTION_TIMEOUT` | `10000` | Cap (ms) on interactions — a wedged page fails fast instead of hanging. |
| `DEVLOOP_NAV_TIMEOUT` | `30000` | Cap (ms) on navigations. |
| `DEVLOOP_LOG_CAPACITY` | `5000` | Max buffered events. |
| `DEVLOOP_DEV_CMD` / `DEVLOOP_DEV_CWD` | _(none)_ | Optional dev-server auto-start on boot (normally use `dev_start`). |
| `DEVLOOP_HOME` | `~/.devloop` | Registry location. |

## Cockpit mode (Electron)

```sh
bun run app          # build + launch the cockpit
bun run app:selftest # headless integration test (no visible windows)
```

Two windows open:
- **app pane(s)** — the embedded browser (a real Chromium `webContents` driven via CDP). Multiple panes = multiple targets.
- **timeline** — the control surface:
  - **pane tabs** — `all | pane-1 | … | + pane`; click to select (also filters the timeline to that pane), `×` to close. Updates live whether panes change from the UI or from Claude.
  - **project picker** — dropdown of saved projects + **open** (dev_start + navigate to its URL) + **📁 browse** (native folder dialog → fills cwd) + **save as**.
  - **repro builder** — `+ step` / `run ▶`; assemble an action sequence and run it through the same `repro` tool.
  - **dev server** start/stop + status, a **URL bar**, and the live event list with per-source coloring, target tags, substring filter, and **errors only**.

The cockpit serves the same tools over **MCP-over-HTTP** (stateful sessions). It auto-picks a free port starting at `DEVLOOP_HTTP_PORT` (default 7333) and logs the URL. Point Claude at the running cockpit:

```sh
claude mcp add --transport http devloop-cockpit http://localhost:7333/mcp
```
(Only connected while `bun run app` is running.)

**Clean teardown:** closing the timeline window (or quit / SIGTERM / SIGINT) tears down everything — the dev-server process group, all browser panes, and the HTTP server — so no orphaned `next dev` and no held ports.

Cockpit-only env: `DEVLOOP_HTTP_PORT` (default 7333), plus the shared `DEVLOOP_NET_THRESHOLD` / `DEVLOOP_ACTION_TIMEOUT` / `DEVLOOP_LOG_CAPACITY` / `DEVLOOP_HOME`.

## Project layout

```
src/
  logBuffer.ts          source-aware, timestamped ring buffer (+ live onPush)
  devServer.ts          runtime dev-server manager (process-group kill) + detectDevCommand
  registry.ts           persisted project registry
  browserController.ts  IBrowserController + IBrowserManager interfaces
  browser.ts            PuppeteerBrowserController (headless/stdio)
  electronBrowser.ts    ElectronBrowserController (cockpit; CDP debugger)
  toolLayer.ts          TOOLS + handleTool, bound via configureTools(deps)
  index.ts              stdio entry (Puppeteer + stdio)
cockpit/
  main.ts               Electron main: windows, BrowserManager, MCP-over-HTTP, lifecycle
  browserManager.ts     multi-pane manager (IBrowserManager)
  preload.ts            contextBridge IPC surface
  renderer/             timeline window (index.html + timeline.ts)
  build.ts              Bun build for main/preload/renderer
```

## Test

```sh
bun run typecheck
bun run test-smoke.ts   # headless Puppeteer: structured args, networkidle, repro sequence, abort
bun run app:selftest    # headless Electron: 8-stage check — substrate→buffer, tool layer,
                        # MCP-over-HTTP, renderer IPC, registry, multi-target panes, repro
                        # builder, and process-group cleanup on quit
```

## Gotchas learned in the field

- **Port conflicts surface as browser 500s.** Wiring against an Expo app while another held port 8081 produced a browser-side `500`; the *server* logs showed Expo had skipped starting. Pin a free port per app — and a good example of why the unified timeline helps.
- **`bun run dev` spawns the real server as a grandchild.** Killing the shell orphans `next dev`/`metro`; that's why the dev server is spawned detached and stopped by process group.
- **Don't pass `CI=1` for interactive use** — it disables Metro watch/HMR.

## Where to take it next

- **Network bodies** — capture request/response payloads via `Network.*` CDP events (currently method/status/url).
- **Render `repro` results inline** in the timeline (currently a one-line summary).
- **Self-healing re-acquire for Electron panes** (the Puppeteer substrate already recovers from target loss).

_Done: unified browser+server timeline · `get_logs_around` correlation · `repro` one-shot + action sequences · `waitFor: networkidle` · structured console args · bounded interaction timeouts · self-healing re-acquire (Puppeteer) · project registry · Electron cockpit with multi-pane targets, project picker, folder browse, and visual repro builder · MCP-over-HTTP · clean process-group teardown._
