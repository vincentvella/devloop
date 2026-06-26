/**
 * Smoke test: drive the *running* cockpit over its MCP-over-HTTP endpoint, exactly
 * as a remote Claude would — including actually starting the dev server and proving
 * the screenshot is of the live app. Run with the cockpit up: `bun run mcp-drive.ts`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT = process.env.DEVLOOP_URL ?? "http://localhost:7333/mcp";
const txt = (r: any) => r.content?.find((c: any) => c.type === "text")?.text ?? "";
const img = (r: any) => r.content?.find((c: any) => c.type === "image");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "mcp-drive", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
console.log(`connected → ${ENDPOINT}`);

// 1) active pane + its configured cwd/cmd
const panes = JSON.parse(txt(await call("pane_list"))).panes as {
  id: string;
  label?: string;
  active: boolean;
  url: string;
  dev?: { running: boolean; cmd?: string; cwd?: string };
}[];
const active = panes.find((p) => p.active) ?? panes[0]!;
console.log(
  `\nactive pane: ${active.id} (${active.label}) — cwd=${active.dev?.cwd} running=${active.dev?.running} url=${active.url}`,
);
if (!active.dev?.cwd) {
  console.log("no cwd configured on the active pane — set one in the cockpit first. Aborting.");
  await client.close();
  process.exit(1);
}

// 2) start the dev server over MCP (uses the pane's cmd, else auto-detect) — unless already up
if (!active.dev?.running) {
  await call("clear_logs");
  console.log(
    `\ndev_start({ cwd: ${active.dev.cwd}${active.dev.cmd ? `, cmd: ${active.dev.cmd}` : " (auto-detect)"} }) …`,
  );
  console.log(
    "dev_start →",
    txt(await call("dev_start", { cwd: active.dev.cwd, ...(active.dev.cmd ? { cmd: active.dev.cmd } : {}) })),
  );
} else {
  console.log("\ndev server already running — skipping dev_start");
}

// 3) wait for the server to announce a localhost URL (the pane auto-navigates to it)
let liveUrl = active.dev?.running ? active.url : "";
for (let i = 0; i < 40 && !liveUrl; i++) {
  await sleep(1000);
  const logs = JSON.parse(txt(await call("get_logs", { app: active.id, grep: "localhost:\\d+", limit: 5 })));
  liveUrl = logs.entries.map((e: any) => e.line.match(/https?:\/\/localhost:\d+/)?.[0]).find(Boolean) ?? "";
}
console.log(`\nserver URL: ${liveUrl || "(none within 40s)"}`);
const status = JSON.parse(txt(await call("dev_status")));
console.log(`dev_status → running=${status.running} name=${status.name} pid=${status.pid ?? "?"}`);

// 4) wait for the real app to actually paint, then prove its identity
let proofVal = "";
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  proofVal = JSON.parse(
    txt(
      await call("browser_eval", {
        expression:
          "JSON.stringify({ href: location.href, title: document.title, h1: document.querySelector('h1')?.innerText ?? null, ready: document.readyState, bodyLen: document.body.innerText.length })",
      }),
    ),
  ).value;
  const v = JSON.parse(proofVal);
  if (v.ready === "complete" && v.bodyLen > 50 && v.h1 !== "Loading…") break;
}
console.log(`\nbrowser_eval (page identity) → ${proofVal}`);

// 5) correlated logs from this app only
const appLogs = JSON.parse(txt(await call("get_logs", { app: active.id, limit: 8 })));
console.log(`\nget_logs(app=${active.label}) last ${appLogs.count}:`);
for (const e of appLogs.entries.slice(-8)) console.log(`   [${e.source}:${e.stream}] ${e.line.slice(0, 90)}`);

// 6) screenshot of the live app
const shot = img(await call("browser_screenshot", { fullPage: false }));
console.log(`\nbrowser_screenshot → ${shot ? `${shot.mimeType}, ${shot.data.length} b64 chars` : "NONE"}`);

await client.close();
console.log("\n✓ drive complete (dev server left running)");
