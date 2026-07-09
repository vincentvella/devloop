import { Mermaid } from "./Mermaid";

const chart = `%%{init: {"flowchart": {"wrappingWidth": 700}}}%%
flowchart TD
  clients["<b>MCP clients</b><br/>Claude Code · agents · mcporter"]
  clients --> stdio & daemon & cockpit

  stdio["<b>stdio</b><br/><i>spawned per session</i>"]
  daemon["<b>daemon</b><br/><i>HTTP/SSE · one shared instance</i>"]
  cockpit["<b>cockpit</b><br/><i>HTTP/SSE · Electron app</i>"]

  stdio --> mcp
  daemon --> mcp
  cockpit --> mcp
  mcp(["<b>MCP Server</b><br/><i>stdio transport, or HTTP/SSE for the daemon + cockpit</i>"])
  mcp --> core

  core["<b>shared core</b> · <i>transport- and substrate-agnostic</i><br/>the MCP tool layer + one unified, correlated timeline"]

  core --> iface(["<b>IBrowserController · IBrowserManager · ITargetController</b><br/><i>capability-gated by the active target</i>"])
  iface --> pup & elec & rn

  pup["<b>web</b> · Puppeteer / Chrome<br/><i>stdio + daemon</i>"]
  elec["<b>web</b> · Electron CDP panes<br/><i>cockpit · per-project partitions</i>"]
  rn["<b>native</b> · React Native (Hermes)<br/><i>JS + network over Metro CDP</i>"]

  rn -->|"idb / adb"| nd["<b>NativeDriver</b><br/>iOS idb · Android adb<br/>taps · snapshot · screens · logs"]`;

export function Architecture() {
  return (
    <section>
      <h2>Architecture</h2>
      <p className="tag" style={{ fontSize: 14, marginBottom: 14 }}>
        Three transports expose one shared, transport- &amp; substrate-agnostic core, which
        drives a browser — or a native device. Everything lands on one timeline.
      </p>
      <Mermaid chart={chart} />
    </section>
  );
}
