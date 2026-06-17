<p align="center">
  <img src="assets/wordmark.svg" alt="Devloop" width="280" />
</p>

<p align="center">
  Browser control + dev-server logs on one correlated timeline — for AI agents and humans.
</p>

---

A unified dev-loop tool: it drives a **browser** and your **dev server**, pushing both sides into one timestamped buffer so you can correlate a browser console error with the backend stack trace from the same moment. It runs two ways from a shared core:

- **Headless (stdio)** — drives Chrome via Puppeteer, served over stdio. The lightweight mode Claude Code spawns per session.
- **Cockpit (Electron)** — a single desktop window: tabbed browser panes (embedded `WebContentsView`s driven via CDP) with a browser bar (back/forward/reload + address) beside a collapsible side panel that toggles between **logs** and a **repro builder**. Project picker, auto-navigate, pop-out targets. The renderer is React 19 + Tailwind v4 + Radix + lucide-react. Serves the same tools over HTTP.

Because every event (browser console/network/page-errors **and** server stdout/stderr) shares one monotonic clock, `get_logs_around` / `repro` return a correlated, cross-source slice of the timeline.

### Native targets — Expo / React Native (iOS)

The cockpit also drives **Expo/React Native** projects, not just web. Open a native project and you get one pane with a **Web · iOS** target switcher, a **bundler** toggle (Metro) separate from a **Build** button (`expo run:ios`, with `@expo/fingerprint` staleness detection), and:

- **JS console + errors over CDP** via Metro's Hermes inspector — with **source-mapped** stacks (your bundled `index.bundle:1:…` resolves to original `.tsx`).
- **Native device logs** (`simctl log stream`) merged onto the same timeline as a `native` source.
- A **live, interactive iOS simulator embedded in the pane** (via [serve-sim](https://github.com/EvanBacon/serve-sim) — tap/scroll/type), with screenshots.

All of it lands on the same correlated timeline, app-scoped — the web dev-loop experience, for a native app. (macOS + Apple Silicon for the embedded simulator.)

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

**Headless MCP (stdio)** — no clone needed, register it with Claude Code:

```sh
claude mcp add devloop --scope user -- npx -y devloop-mcp
```

(Published as [`devloop-mcp`](https://www.npmjs.com/package/devloop-mcp) on npm; Puppeteer fetches Chromium on first install.)

**Cockpit (desktop app)** — grab the installer for your OS from [Releases](https://github.com/vincentvella/devloop/releases) (`.dmg` / `.exe` / `.AppImage`). macOS ships both Apple Silicon (`arm64`) and Intel (`x64`) builds. The app checks GitHub for a newer release on launch and prompts before downloading or installing — or trigger it yourself from **settings → updates → check for updates**.

**From source** (dev) — requires [bun](https://bun.sh):

```sh
bun install
bun run app          # build + launch the Electron cockpit
bun run start        # or run the stdio MCP directly
```

## Tools (33)

**Dev server** — runtime, no per-project registration needed
- `dev_start({ project?, cmd?, cwd? })` — start a dev server and tee its logs. Specify it three ways: a saved registry `project`; explicit `cmd`+`cwd`; or neither (`cwd` defaults to the server's dir, `cmd` auto-detected from `package.json` scripts: `dev`/`develop`/`web`/`start`/`serve`).
- `dev_stop()` — stop it. Kills the whole **process group** (so `next dev`/`metro` grandchildren die too).
- `dev_status()` — running?, plus cmd/cwd/pid.

**Browser control** — act on the active pane
- `browser_navigate({ url })`
- `browser_screenshot({ fullPage? })` → PNG image
- `browser_click({ selector })`
- `browser_type({ selector, text })`
- `browser_hover({ selector })` · `browser_scroll({ selector? | x?, y? })` · `browser_select({ selector, value })` · `browser_press({ key, selector? })` — keys like `Enter`/`Escape`/`Tab`/`ArrowDown`.
- `browser_wait_for_idle({ idleMs?, timeoutMs? })` — wait until network settles.
- `browser_clear_storage({ allOrigins? })` — clear cookies / localStorage / IndexedDB / cache / service workers for the current origin (or the whole session) — log out / test a fresh user.
- `browser_emulate({ device? | width?, height?, mobile?, deviceScaleFactor?, userAgent?, reset? })` — emulate a device/viewport (`device`: `iphone`/`ipad`/`pixel`, or custom; `reset` → desktop).
- `browser_throttle({ profile })` — network conditions: `slow-3g` / `fast-3g` / `offline` / `none`.
- `browser_eval({ expression })` — runs in page context (not blocked by CSP)
- `browser_snapshot()` — structured page snapshot: url, title, and interactive/landmark elements (role, accessible name, value/state, heading level) each with a CSS selector `ref` usable by `browser_click`/`browser_type`. **Prefer this over a screenshot** to find/target elements reliably.
- `browser_wait_for({ selector?, text?, timeoutMs? })` — wait until a selector appears or text is present (after a navigation/async render). Returns `{ ok, waitedMs }`.

**Logs & correlation**
- `get_logs({ source?, stream?, grep?, app?, sinceSeq?, limit? })` — unified tail. `source` is `server`|`browser`; `stream` is `stdout`/`stderr`/`console`/`network`/`pageerror`. `app` scopes to one project's logs — it matches a pane's **label** (project name) or id (see `pane_list`) and filters *both* that pane's server and browser logs, regardless of which pane is active. Pass the last `seq` as `sinceSeq` to tail incrementally.
- `get_logs_around({ ts, windowMs?, source?, app? })` — **the correlation tool**: all events within ±`windowMs` of a timestamp, time-ordered across both sources (optionally scoped to one `app`).
- Logged **network** events (failures + status ≥ `DEVLOOP_NET_THRESHOLD`; set the threshold to `0` to capture everything) carry rich `detail` on **both substrates**: method, status, resource type, mime, duration, request + response **headers**, and capped request/response **bodies**.
- `export_har({ app? })` — export captured network as a **HAR 1.2** document (import into Chrome DevTools / Charles). Scope to one `app` if you like.
- `diagnose({ windowMs?, app? })` — **triage what's broken right now**: groups/dedupes repeated errors (console / page / server) with counts, lists failed/4xx-5xx network requests, and returns a one-line summary. Start here before digging through `get_logs`.
- **Page errors carry a `resolvedStack`** — minified browser stack traces are mapped back to original source via the bundle's source map (the browser only de-minifies in its DevTools UI; `error.stack` stays compiled, so we resolve it for you). On the entry's `detail`.
- `export_bundle({ app?, windowMs? })` — a shareable **bug-report bundle** (JSON): diagnose summary + timeline + screenshots + HAR + repro. The cockpit's **report** button saves it as a self-contained HTML page.
- `clear_logs()` — reset before reproducing an issue.
- `repro({ actions | action, waitFor?, settleMs?, stepSettleMs?, idleMs?, timeoutMs?, continueOnError?, clear? })` — **reproduce-and-correlate**: clears the buffer, performs one action or a **sequence**, waits, and returns everything that happened on both sides across the sequence — with per-step results (`steps[]`), a `byStream` count, and a pre-filtered `errors` list.
  - `actions: [{kind, ...}]` — kinds: `navigate`/`click`/`type`/`hover`/`scroll`/`select`/`press`/`eval`/`wait`/`none`. `action` (singular) = one-step convenience.
  - Waits `stepSettleMs` (default 300) between steps, `settleMs` (default 1000) after the last. `waitFor: "networkidle"` waits until no network activity for `idleMs` (default 500) up to `timeoutMs` (default 10000) — **use it for slow/streaming responses** (Expo's first web bundle takes ~12s). On timeout you still get what landed, with a `waitNote`.
  - `continueOnError` (default false) — otherwise stops at the failing step (`stoppedAtStep`).

**Project registry** — saved projects, persisted to `~/.devloop/projects.json`
- `project_list()` — list saved projects (name, cwd, cmd, url, steps).
- `project_add({ name, cwd, cmd?, url?, steps? })` — save/replace a project (incl. a saved repro `steps` sequence), so you can `dev_start({ project })` by name.
- `project_remove({ name })`.

**Panes** — multi-target (cockpit only; stdio mode is single-pane and reports so)
- `pane_list()` — each pane: `{ id, url, active, popped }`. The active pane is what `browser_*`/`repro` target; events are tagged with their pane `id`.
- `pane_new({ url? })` — open a new pane and make it active.
- `pane_select({ id })` — make a pane active.
- `pane_close({ id })`.
- `pane_pop({ id })` — detach a pane into its own standalone window (side-by-side targets).

### Console arguments

`console.log(obj)` is captured with arguments resolved to real values (e.g. `[log] user {"id":7}`), not `JSHandle@object`. The Electron substrate renders them synchronously from CDP previews; the Puppeteer substrate uses a *reserve-then-fill* pattern (stamp `seq`/`ts` synchronously at arrival, patch resolved args in afterward) so ordering matches emit order and interleaves correctly with server logs.

## Headless mode (stdio)

Register **once**, at user scope — works for every project:

```sh
claude mcp add devloop --scope user -- npx -y devloop-mcp
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

**One window** (React 19 + Tailwind v4 with `@theme` tokens + Radix `Dialog`/`Tooltip` + lucide-react icons), laid out as:
- **Top bar** — the **pane tabs**, then the active pane's **dev controls** + window toggles:
  - **dev controls** (act on the active pane): a status chip (`● project` green when running, `✗ exited (code N)` red on a non-zero exit, else `dev: stopped`/`not configured`), **▶/⏹** start-stop the dev server, **⟳** restart it (Power), **📷** screenshot the pane into the timeline.
  - `⚙` settings · `⤢` pop out the active pane into its own window.
  - Tabs are auto-named from the project (`package.json` `name`, else folder basename), carry a **green running dot** when that pane's server is up, show `⤢` when popped; **click** to switch (the timeline follows the active pane), **double-click** to rename, `×` to close, `+ pane` to add. Live-updates whether panes change from the UI or from Claude.
- **Browser bar** (above the pane) — **←/→** back/forward (disabled when there's no history), **⟲** reload, **⤓** hard-reload (ignore cache), **⌫ clear site data** (cookies/localStorage + reload), and an **address bar** showing the active pane's live URL — it follows link clicks / SPA route changes (the manager listens to `did-navigate`); accepts a bare port (`3000` → `http://localhost:3000`) or any `http(s)://` URL; Enter navigates (`⌘L` focuses).
- **Browser area** — the active pane: a real Chromium `WebContentsView` driven via CDP. Other panes keep running in the background (their logs keep flowing); the active one is positioned over this region and reflows when you collapse panels or resize.
- **Settings** (behind `⚙`, collapsed by default so the top bar stays clean) — labeled rows:
  - **project** — dropdown of saved projects; **picking one opens it immediately** (fills cmd/cwd/url + repro steps, then dev-starts + navigates). **💾 save** snapshots the active pane as a project named by its tab label (rename on the tab).
  - **dev** — `cmd` (blank = auto-detect) + **📁 folder** picker + `cwd`. **Auto-saved to the active pane on blur** (and on folder pick) — no separate "apply" button; after that the top-bar **▶** is pre-wired.
  - **ext** — load Chrome extensions into the panes (React/Redux DevTools, or your own under dev): install by **Chrome Web Store id/URL**, or **📁 load an unpacked** folder. Extensions persist and reload on launch, and live in the panes' session (isolated from the cockpit UI). Powered by `electron-chrome-web-store`; Electron's extension API is partial (MV3 mostly works; some `chrome.*` gaps).
- **Side panel** (collapsible) — a segmented **logs / repro** control:
  - **logs** — the live event list (per-source coloring, timestamps, pane tags, click-to-expand long rows, screenshot thumbnails → Radix-`Dialog` lightbox). **Network rows** are status-tier colored (2xx/3xx/4xx/5xx) and expand to show method/status/duration + request/response **headers and bodies**. Sticky filter bar: substring filter + chips (`server`/`console`/`network`/`errors`/`repro`), a `↓ latest` pill, **HAR** export, and `clear`. **Always scoped to the active pane.**
  - **repro** — the **repro builder** (`+ step` / `pick` / `run`); **pick** lets you click an element in the page to capture a stable selector straight into a click step; results land in the **logs** timeline (it auto-switches there) with per-step ✓/✗ and the correlated error list.
  - Collapse via the `›` in the panel header; re-expand via a small **hover handle** on the right edge. Popping the active pane into its own window **fills the freed space with the timeline**. Drag the divider to resize.
- **Pop-out window** — `⤢` (right of the URL bar) detaches the active pane into its **own browser window with its own bar** (back/forward/reload/hard-reload/address/screenshot), driving that pane by id; the live URL tracks navigations and `⌘R` reloads the page. Closing it re-docks the pane.
- **Keyboard:** `⌘L` address bar · `⌘R`/`⌘⇧R` reload/hard-reload · `⌘K` clear · `⌘B` toggle panel · `⌘,` settings · `⌘1–9` switch panes.

**Per-pane projects:** each pane has its own dev server and config (cmd/cwd) — so different panes run different projects (on different ports) at once, and the controls act on whichever pane is active.

**Auto-navigate:** on dev-start (or opening a project), the cockpit watches that pane's server output and opens the first `http://localhost:PORT` it announces in the pane — no port-typing.

**Persistence & restore:** open panes (each pane's URL, project label, and dev config) are saved to `~/.devloop/panes.json` and restored on relaunch; the form state (repro steps + selected project) is saved to `~/.devloop/session.json`. Restore **does not assume a dev server is running** — a pane whose saved URL is a dev (`localhost`) URL comes back as a "press ▶ to start" placeholder (its real URL preserved), and hitting **▶** starts the server and auto-navigates.

The cockpit serves the same tools over **MCP-over-HTTP** (stateful sessions). It auto-picks a free port starting at `DEVLOOP_HTTP_PORT` (default 7333) and logs the URL. Point Claude at the running cockpit:

```sh
claude mcp add --transport http devloop-cockpit http://localhost:7333/mcp
```
(Only connected while `bun run app` is running.)

**Clean teardown:** closing the window (or quit / SIGTERM / SIGINT) tears down everything — the dev-server process group, all browser panes, and the HTTP server — with a hard-exit fallback if graceful quit stalls. And the dev server runs under a **parent-pid watchdog**, so even a crash/SIGKILL of the cockpit can't orphan it (no `next dev` left holding `:3000`).

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
  renderer/             React UI — main.tsx (app) + global.d.ts (IPC types) +
                        styles.css (Tailwind v4 @theme) + index.html
  build.ts              Bun build for main/preload/renderer + Tailwind CLI step
```

## Test

```sh
bun run typecheck
bun run test-smoke.ts   # headless Puppeteer: structured args, networkidle, repro sequence, abort
bun run app:selftest    # headless Electron: substrate→buffer, tool layer, MCP-over-HTTP,
                        # renderer IPC, registry, multi-target panes + pop-out, auto-navigate,
                        # derived project name, per-pane dev (server-log tagging), app-scoped
                        # get_logs, inline repro builder, pane persistence/restore, teardown
bun run mcp-drive.ts    # live smoke test: drives a RUNNING cockpit over its MCP-over-HTTP
                        # endpoint (start dev server → auto-navigate → verify the live app via
                        # browser_eval → app-scoped get_logs → screenshot). Cockpit must be up.
```

## Gotchas learned in the field

- **Port conflicts surface as browser 500s.** Wiring against an Expo app while another held port 8081 produced a browser-side `500`; the *server* logs showed Expo had skipped starting. Pin a free port per app — and a good example of why the unified timeline helps.
- **`bun run dev` spawns the real server as a grandchild.** Killing the shell orphans `next dev`/`metro`; that's why the dev server is spawned detached and stopped by process group.
- **Don't pass `CI=1` for interactive use** — it disables Metro watch/HMR.

## Where to take it next

- **Stdout/network parity for Puppeteer** — the Puppeteer substrate logs method/status/url; bring request/response **bodies** there too (the Electron substrate captures them).
- **HTTP/SSE for stdio** — a long-lived shared daemon outside the cockpit.

_Done: unified browser+server timeline · `get_logs_around` correlation · `repro` one-shot + action sequences (results rendered inline) · `waitFor: networkidle` · structured console args · bounded interaction timeouts · self-healing re-acquire (Puppeteer **and** Electron panes — recover from renderer crash) · **network request/response bodies** (capped, base64-decoded, on logged Electron entries) · project registry (with saved repro steps) · session persistence · single-window Electron cockpit — tabbed panes, collapsible toolbar + timeline, pop-out, project-named tabs · per-pane dev servers, configure-once (auto-saved) · auto-navigate from logs · pane persistence + restore (no "assume running") · **React 19 + Tailwind v4 + Radix + lucide-react** renderer · browser bar (back/forward/reload + live address) · segmented logs/repro panel · **pop-out windows with their own browser chrome** · screenshot → timeline (thumbnail + lightbox) · dev failed-state indicator · project picker (open-on-pick) + folder browse · visual repro builder · MCP-over-HTTP · clean process-group teardown + crash watchdog · Electron security-warning suppression._
