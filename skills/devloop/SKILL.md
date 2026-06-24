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

## Notes

- The daemon is **shared** — many agents/sessions hit one browser, one dev server, one timeline.
- Persist the server in mcporter's config (`~/.mcporter/mcporter.json`) or rely on its auto-import from an
  existing Claude/Cursor/Codex MCP config, so you can drop the `--http-url` flags and just call `devloop.<tool>`.
