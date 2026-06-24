---
name: devloop
description: >-
  Drive Devloop — browser + dev-server on one correlated timeline (web, plus native
  iOS/Android Expo apps) — by calling its MCP tools as shell commands via mcporter.
  Use when Devloop's MCP server isn't wired into this agent directly (e.g. a sandboxed
  or enterprise setup that blocks MCP) but you can run shell commands.
---

# Drive Devloop via mcporter

[Devloop](https://github.com/vincentvella/devloop) puts a **browser** and your **dev server** on one
timestamped timeline, so a browser error and the backend log from the same moment sit side by side. It
exposes that as MCP tools: start a dev server, drive a browser (navigate / click / type / snapshot /
screenshot), capture logs + network, `diagnose` what's broken, and `repro` a flow — plus native iOS/Android.

When the Devloop MCP server is connected to this agent directly, just call the tools. **When it isn't — but
you have a shell — use [mcporter](https://mcporter.sh) to call the same tools as commands.**

## Setup (once per machine)

Run one shared, long-running Devloop and point mcporter at it:

```sh
# Start a headless daemon (one shared instance on :7333). Use npx if devloop-mcp isn't installed.
devloop-mcp daemon &              # or: npx -y devloop-mcp daemon &

# Sanity-check + discover tools (use --schema to see every tool's signature):
npx mcporter list --allow-http --http-url http://localhost:7333/mcp --name devloop --schema
```

If spawning a process per call is fine and you'd rather not run a daemon, point mcporter at stdio instead:
`npx mcporter list --stdio "npx -y devloop-mcp" --name devloop`.

> `--allow-http` is required because the localhost URL is cleartext. Exact flags can vary by mcporter
> version — `npx mcporter --help` is authoritative.

## Calling tools

```sh
M='npx mcporter call --allow-http --http-url http://localhost:7333/mcp'

$M 'devloop.dev_start(cwd: "/abs/path/to/project")'          # start the dev server (auto-detects the cmd)
$M 'devloop.browser_navigate(url: "http://localhost:3000")'
$M 'devloop.browser_snapshot()'                               # a11y tree with refs for click/type
$M 'devloop.browser_click(selector: "#submit")'
$M 'devloop.get_logs(stream: "network", limit: 50)'
$M 'devloop.diagnose()'                                       # triage: grouped errors + failed requests
$M 'devloop.export_har()'                                     # full network as HAR 1.2
```

## Recipes

- **Reproduce + correlate a bug** — `dev_start`, then one `repro` with a sequence; it clears the timeline,
  runs the steps, waits for things to settle, and returns everything that happened on both sides:
  ```sh
  $M 'devloop.repro(actions: [{kind:"navigate", url:"http://localhost:3000/checkout"}, {kind:"click", selector:"#pay"}], waitFor:"networkidle")'
  ```
- **Triage first** — `diagnose()` before digging through `get_logs`; it dedupes errors and lists failed/4xx-5xx requests.
- **Native (Expo / React Native)** — `native_open(platform: "ios")` (or `"android"`), then the same
  `browser_*` tools drive the device (snapshot/tap/type via idb/adb); `native_build(platform: "ios")` to
  (re)build. Native tools require the Devloop **cockpit** (the desktop app), not the headless daemon.

## All tools

The complete tool set, so you don't need introspection. Optional args end in `?`. Call any of these as
`$M 'devloop.<name>(arg: value, …)'`. (`npx mcporter list devloop --schema` is the live, authoritative
list if this drifts from your installed version.)

**Browser** — act on the active pane/target:
- `browser_navigate(url)` — open a URL.
- `browser_snapshot()` — accessibility tree: url, title, and interactive/landmark elements each with a CSS-selector `ref`. **Prefer this over a screenshot** to find/target elements.
- `browser_click(selector)` · `browser_type(selector, text)` · `browser_hover(selector)` · `browser_scroll(selector?, x?, y?)` · `browser_select(selector, value)` · `browser_press(key, selector?)` — keys like `Enter`/`Tab`/`ArrowDown`.
- `browser_screenshot(fullPage?)` → PNG.
- `browser_eval(expression)` — run JS in page context (not CSP-blocked).
- `browser_wait_for(selector?, text?, timeoutMs?)` — wait until a selector/text appears.
- `browser_wait_for_idle(idleMs?, timeoutMs?)` — wait until the network settles.
- `browser_emulate(device?, width?, height?, mobile?, deviceScaleFactor?, userAgent?, reset?)` — `device`: `iphone`/`ipad`/`pixel`; `reset:true` → desktop.
- `browser_throttle(profile)` — `slow-3g`/`fast-3g`/`offline`/`none`.
- `browser_clear_storage(allOrigins?)` — clear cookies/localStorage/IndexedDB/cache/SW.

**Logs & correlation:**
- `get_logs(source?, stream?, grep?, app?, sinceSeq?, limit?)` — unified tail. `source`: `server`/`browser`/`native`; `stream`: `stdout`/`stderr`/`console`/`network`/`pageerror`. `app` scopes to one project.
- `get_logs_around(ts, windowMs?, source?, app?)` — everything within ±`windowMs` of a moment, time-ordered across sources (the correlation tool).
- `get_network(grep?, app?, limit?)` — every request (full ring, independent of the log threshold).
- `diagnose(windowMs?, app?)` — grouped/deduped errors + failed (4xx/5xx) requests + a one-line summary. **Start here.**
- `export_har(app?)` — full network as HAR 1.2. `export_bundle(app?, windowMs?)` — shareable bug-report bundle (diagnose + timeline + screenshots + HAR + repro). `clear_logs()` — reset before reproducing.

**Dev server:** `dev_start(project?, cmd?, cwd?)` (saved `project`, or `cmd`+`cwd`, or neither → cwd defaults + cmd auto-detected) · `dev_stop()` · `dev_status()`.

**Project registry:** `project_list()` · `project_add(name, cwd, cmd?, url?)` · `project_remove(name)`.

**Panes** (cockpit, multi-target): `pane_list()` · `pane_new(url?)` · `pane_select(id)` · `pane_close(id)` · `pane_pop(id)`.

**Native** (cockpit only): `native_open(platform)` (`ios`/`android` — opens the sim/mirror + routes `browser_*` to it) · `native_close()` · `native_build(platform, cwd?)`.

**repro** — `repro(actions?, action?, waitFor?, settleMs?, stepSettleMs?, idleMs?, timeoutMs?, continueOnError?, clear?)`: clears the timeline, runs one `action` or an `actions` sequence, waits, and returns everything that happened on both sides. `actions: [{kind, …}]` — kinds `navigate`/`click`/`type`/`hover`/`scroll`/`select`/`press`/`eval`/`wait`/`none`. `waitFor: "networkidle"` for slow/streaming responses.

## Notes

- The daemon is **shared** — many agents/sessions hit one browser, one dev server, one timeline.
- Persist the server in mcporter's config (`~/.mcporter/mcporter.json`) or rely on its auto-import from an
  existing Claude/Cursor/Codex MCP config, so you can drop the `--http-url` flags and just call `devloop.<tool>`.
