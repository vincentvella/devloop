/** Sequential smoke test: drives devloop-mcp as a real MCP client. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/index.ts"],
  env: { ...process.env, DEVLOOP_HEADLESS: "true" } as Record<string, string>,
});
const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const page = "data:text/html,<script>console.log('user', {id:7, name:'vince', nested:{ok:true}});console.error('boom');setTimeout(()=>{throw new Error('kaboom')},10)</script>";
console.log("navigate:", await callText("browser_navigate", { url: page }));
await new Promise((r) => setTimeout(r, 300)); // let async pageerror fire
console.log("eval 1+2+3:", await callText("browser_eval", { expression: "1+2+3" }));

const logs = JSON.parse(await callText("get_logs", { source: "browser" }));
console.log(`\nbrowser events captured: ${logs.count}`);
for (const e of logs.entries) console.log(`  [${e.stream}] ${e.line}`);

const errPage = "data:text/html,<script>console.error('repro fail');fetch('https://127.0.0.1:1/nope').catch(()=>{})</script>";
const repro = JSON.parse(await callText("repro", { action: { kind: "navigate", url: errPage }, waitFor: "networkidle", idleMs: 400, timeoutMs: 5000 }));
console.log(`\nrepro: waitFor=${repro.waitFor} note=${repro.waitNote ?? "-"} total=${repro.total} errorCount=${repro.errorCount} byStream=${JSON.stringify(repro.byStream)}`);
for (const e of repro.errors) console.log(`  ERROR [${e.source}:${e.stream}] ${e.line}`);

// --- action sequence: navigate -> type -> click ---
const formPage = `data:text/html,<input id=name><button id=go onclick="console.log('typed:'+document.getElementById('name').value)">go</button>`;
const seq = JSON.parse(
  await callText("repro", {
    actions: [
      { kind: "navigate", url: formPage },
      { kind: "type", selector: "#name", text: "hello" },
      { kind: "click", selector: "#go" },
    ],
    settleMs: 400,
    stepSettleMs: 200,
  }),
);
console.log(`\nsequence: stepCount=${seq.stepCount} stoppedAtStep=${seq.stoppedAtStep}`);
for (const s of seq.steps) console.log(`  step ${s.index} ${s.action.kind}: ${s.error ? "ERR " + s.error : "ok"}`);
console.log(`  console output:`);
for (const e of seq.entries.filter((e: any) => e.stream === "console")) console.log(`    ${e.line}`);

// --- abort on a bad step ---
const abort = JSON.parse(
  await callText("repro", {
    actions: [
      { kind: "navigate", url: formPage },
      { kind: "click", selector: "#does-not-exist" },
      { kind: "eval", expression: "999" },
    ],
    settleMs: 300,
    stepSettleMs: 150,
    timeoutMs: 2000,
  }),
);
console.log(`\nabort: stepCount=${abort.stepCount} stoppedAtStep=${abort.stoppedAtStep} (eval should NOT run)`);
for (const s of abort.steps) console.log(`  step ${s.index} ${s.action.kind}: ${s.error ? "ERR " + s.error.slice(0, 60) : "ok"}`);

await client.close();
process.exit(0);

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return res.content.find((c) => c.type === "text")?.text ?? "(no text)";
}
