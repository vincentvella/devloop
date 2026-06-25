# Devloop — directory / registry submissions

Working doc (safe to delete). Copy-paste ready. Canonical facts reused everywhere:

- **Name:** Devloop
- **npm:** `devloop-mcp` (v0.5.2) · **bin:** `devloop-mcp`
- **Repo:** https://github.com/vincentvella/devloop
- **Site:** https://devloop.build
- **License:** MIT · **Author:** Vincent Vella
- **Transports:** stdio (per-session) · HTTP/SSE (`devloop-mcp daemon` → http://localhost:7333/mcp)
- **Runtime scope:** 🏠 **local-first** (drives *your* local browser / dev server / simulator) — note this; hosted runtimes can't meaningfully execute it.
- **Platforms:** macOS · Windows · Linux
- **Language:** TypeScript

### Standard MCP client config
```json
{
  "mcpServers": {
    "devloop": {
      "command": "npx",
      "args": ["-y", "devloop-mcp"]
    }
  }
}
```
### One-line install (Claude Code)
```
claude mcp add devloop --scope user -- npx -y devloop-mcp
```

### Descriptions (reuse by length)
- **Tagline (≤80):** Browser + dev-server logs on one correlated timeline — for AI agents and humans.
- **Short (≤160):** An MCP server that drives a browser (or a native Expo/React Native app) and your dev server, putting both on one correlated timeline for AI agents.
- **Medium (≤300):** Devloop drives a browser — or a native iOS/Android Expo app — and your dev server, and puts both on one correlated timeline, so a browser console error and the backend stack trace from the same moment sit side by side. Headless stdio for Claude Code, a shared HTTP/SSE daemon, and an Electron cockpit.

### Tags
`mcp` `browser-automation` `dev-server` `logs` `correlated-timeline` `claude-code` `ai-agents` `puppeteer` `electron` `expo` `react-native` `observability`

### Tool catalog (31 tools)
- **Browser/UI:** browser_navigate, browser_click, browser_type, browser_press, browser_hover, browser_scroll, browser_select, browser_eval, browser_snapshot, browser_screenshot, browser_emulate, browser_throttle, browser_wait_for, browser_wait_for_idle, browser_clear_storage
- **Dev server:** dev_start, dev_stop, dev_status
- **Logs / diagnostics:** get_logs, get_logs_around, clear_logs, get_network, export_har, export_bundle, diagnose
- **Repro:** repro
- **Native (Expo/RN):** native_open, native_close, native_build
- **Panes / projects:** pane_new, pane_close, pane_list, pane_select, pane_pop, project_add, project_remove, project_list

---

## 1. Official MCP Registry (registry.modelcontextprotocol.io) — canonical

Add `server.json` at repo root, then publish with the `mcp-publisher` CLI (GitHub-auth namespace `io.github.<user>`):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.json",
  "name": "io.github.vincentvella/devloop",
  "description": "Drives a browser (or a native Expo/React Native app) and your dev server, putting both on one correlated timeline — for Claude Code and AI agents.",
  "repository": { "url": "https://github.com/vincentvella/devloop", "source": "github" },
  "version": "0.5.2",
  "websiteUrl": "https://devloop.build",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "devloop-mcp",
      "version": "0.5.2",
      "transport": { "type": "stdio" }
    }
  ]
}
```
Publish:
```
brew install mcp-publisher        # or: download from the registry repo releases
mcp-publisher login github         # auth as vincentvella
mcp-publisher publish              # validates server.json and submits
```
> Validate the schema version/field names against the current registry docs before publishing — the schema URL/date moves.

---

## 2. punkpeye/awesome-mcp-servers — PR

Add under the **🖥️ Browser Automation** section, alphabetical by author/name. Legend: 📇 TypeScript · 🏠 local · 🍎 macOS 🪟 Windows 🐧 Linux.

```markdown
- [vincentvella/devloop](https://github.com/vincentvella/devloop) 📇 🏠 🍎 🪟 🐧 - Drives a browser (or a native Expo/React Native app) and your dev server onto one correlated timeline, so a browser console error and the backend stack trace from the same moment line up. Includes `repro`, a unified log/network query API, and an Electron cockpit.
```
PR title: `Add Devloop (browser + dev-server correlated timeline)`

---

## 3. mcp.so — submit form (https://mcp.so/submit)

- **GitHub URL:** https://github.com/vincentvella/devloop
- **Name:** Devloop
- **Description:** (Medium, above)
- **Tags:** (above)
- mcp.so auto-pulls the README; ensure the README top has the install snippet (it does).

---

## 4. Glama (https://glama.ai/mcp/servers) — auto-indexed

Glama crawls public GitHub repos exposing an MCP server. To improve the listing:
- Confirm it appears (search "devloop"); **claim** it via GitHub auth.
- Add a `glama.json` if you want to control metadata:
```json
{ "$schema": "https://glama.ai/mcp/schemas/server.json", "maintainers": ["vincentvella"] }
```

## 5. PulseMCP (https://www.pulsemcp.com/submit) — submit form
- **Name:** Devloop · **GitHub:** repo URL · **Description:** Short/Medium above · **Category:** Browser Automation / Developer Tools.

## 6. Smithery (https://smithery.ai) — list, don't host
Devloop is local-first (it drives *your* browser/sim), so Smithery's **hosted** runtime can't run it. List it as a local/stdio server pointing at npm. Optional `smithery.yaml`:
```yaml
startCommand:
  type: stdio
  configSchema: {}
  commandFunction: |-
    () => ({ command: "npx", args: ["-y", "devloop-mcp"] })
```
Note in the description: "Local stdio server — runs on the developer's machine."

---

## Suggested order (effort vs. payoff)
1. **Official MCP Registry** (server.json + publish) — canonical, feeds many downstreams.
2. **punkpeye/awesome-mcp-servers** PR — highest-authority backlink + real discovery.
3. **mcp.so**, **PulseMCP** — quick forms.
4. **Glama** — verify/claim auto-listing.
5. **Smithery** — list-only.
