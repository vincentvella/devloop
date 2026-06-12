/** Behavioral smoke test: drives the stdio (Puppeteer) server as a real MCP client. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/index.ts"],
  env: { ...process.env, DEVLOOP_HEADLESS: "true" } as Record<string, string>,
});
const client = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await client.connect(transport);

// --- named-assertion harness ---
const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}`);
  if (!cond) fails.push(name);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }> };
  return res.content.find((c) => c.type === "text")?.text ?? "(no text)";
}
const J = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await callText(name, args));

const tools = (await client.listTools()).tools.map((t) => t.name);
check("tools listed", tools.includes("browser_snapshot") && tools.includes("export_har"));

// --- console capture (structured args + page errors) ---
console.log("\n# console capture");
await callText("browser_navigate", {
  url: "data:text/html,<script>console.log('user', {id:7, name:'vince'});console.error('boom');setTimeout(()=>{throw new Error('kaboom')},10)</script>",
});
await sleep(400);
const logs = await J("get_logs", { source: "browser" });
check("structured console args resolved", logs.entries.some((e: any) => e.stream === "console" && e.line.includes("user") && e.line.includes('"id":7')));
check("uncaught page error captured", logs.entries.some((e: any) => e.stream === "pageerror" && e.line.includes("kaboom")));

// --- repro (networkidle) ---
console.log("\n# repro + networkidle");
const repro = await J("repro", {
  action: { kind: "navigate", url: "data:text/html,<script>console.error('repro fail');fetch('https://127.0.0.1:1/nope').catch(()=>{})</script>" },
  waitFor: "networkidle",
  idleMs: 400,
  timeoutMs: 5000,
});
check("repro returns errors", repro.errorCount >= 1 && repro.waitFor === "networkidle");

// --- network detail + HAR ---
console.log("\n# network detail + HAR");
const netLogs = await J("get_logs", { stream: "network", limit: 20 });
const nsample = netLogs.entries.find((e: any) => e.detail?.url);
check("network entry has detail + request headers", !!nsample && !!nsample.detail.requestHeaders);
const har = await J("export_har");
check("HAR has an entry with request headers", har.log.entries.length >= 1 && (har.log.entries[0]?.request?.headers?.length ?? 0) > 0);

// --- snapshot + wait_for ---
console.log("\n# snapshot + wait_for");
await callText("browser_navigate", { url: `data:text/html,<h1>Title</h1><label for=q>Search</label><input id=q><button id=go aria-label="Go now">Go</button>` });
const waitHit = await J("browser_wait_for", { selector: "#go" });
const snap = await J("browser_snapshot");
const byRole = (r: string) => snap.nodes.filter((n: any) => n.role === r);
check("wait_for(hit) ok", waitHit.ok === true);
check("snapshot has heading", byRole("heading").length > 0);
check("snapshot resolves <label> name", byRole("textbox").some((n: any) => n.name === "Search"));
check("snapshot resolves aria-label + #id ref", byRole("button").some((n: any) => n.name === "Go now" && n.ref === "#go"));
check("wait_for(miss) returns ok:false", (await J("browser_wait_for", { selector: "#nope", timeoutMs: 600 })).ok === false);

// --- richer interactions ---
console.log("\n# interactions");
await callText("browser_navigate", { url: `data:text/html,<select id=s><option value=a>A</option><option value=b>B</option></select><input id=t onkeydown="if(event.key==='Enter')window.__p=1"><button id=h onmouseover="window.__h=1">h</button>` });
await callText("browser_select", { selector: "#s", value: "b" });
await callText("browser_press", { key: "Enter", selector: "#t" });
await callText("browser_hover", { selector: "#h" });
await callText("browser_scroll", { y: 40 });
const ixv = JSON.parse((await J("browser_eval", { expression: "JSON.stringify({sel:document.getElementById('s').value,pressed:!!window.__p,hovered:!!window.__h})" })).value);
check("select sets value", ixv.sel === "b");
check("press fires keydown", ixv.pressed === true);
check("hover fires mouseover", ixv.hovered === true);

// --- clear storage ---
console.log("\n# clear storage");
check("clear_storage ok", (await J("browser_clear_storage")).ok === true);

// --- device emulation ---
console.log("\n# emulation");
await callText("browser_navigate", { url: 'data:text/html,<meta name="viewport" content="width=device-width"><h1>vp</h1>' });
await callText("browser_emulate", { device: "iphone" });
const vp = JSON.parse((await J("browser_eval", { expression: "JSON.stringify({w:innerWidth})" })).value);
check("emulate iphone → 390px viewport", vp.w === 390);
await callText("browser_emulate", { reset: true });
const vp2 = JSON.parse((await J("browser_eval", { expression: "JSON.stringify({w:innerWidth})" })).value);
check("emulate reset → wide viewport", vp2.w >= 1000);

// --- diagnose (group/dedupe errors) ---
console.log("\n# diagnose");
await callText("clear_logs");
await callText("browser_navigate", { url: "data:text/html,<script>console.error('[boom] alpha');console.error('[boom] alpha');setTimeout(()=>{throw new Error('DiagErr')},5)</script>" });
await sleep(300);
const diag = await J("diagnose", {});
check("diagnose counts errors", diag.errorCount >= 2);
check("diagnose groups duplicates", diag.groups.some((g: any) => g.count >= 2));
check("diagnose summary mentions errors", /error/i.test(diag.summary));

// --- export_bundle ---
console.log("\n# export_bundle");
const bundle = await J("export_bundle", {});
check("bundle has meta + diagnose + har + logs", !!bundle.meta && !!bundle.diagnose && !!bundle.har && bundle.logs.length > 0);
check("bundle counts the grouped errors", bundle.meta.counts.errors >= 2);

// --- repro sequence + abort ---
console.log("\n# repro sequence + abort");
const formPage = `data:text/html,<input id=name><button id=go onclick="console.log('typed:'+document.getElementById('name').value)">go</button>`;
const seq = await J("repro", { actions: [{ kind: "navigate", url: formPage }, { kind: "type", selector: "#name", text: "hello" }, { kind: "click", selector: "#go" }], settleMs: 400, stepSettleMs: 200 });
check("sequence ran all steps", seq.stepCount === 3 && seq.stoppedAtStep === null);
check("sequence typed value reached the page", seq.entries.some((e: any) => e.stream === "console" && e.line.includes("typed:hello")));
const abort = await J("repro", { actions: [{ kind: "navigate", url: formPage }, { kind: "click", selector: "#does-not-exist" }, { kind: "eval", expression: "999" }], settleMs: 300, stepSettleMs: 150, timeoutMs: 2000 });
check("sequence aborts at the failing step (eval skipped)", abort.stoppedAtStep === 1 && abort.stepCount === 2);

// --- real dev-server lifecycle against the fixture ---
console.log("\n# dev-server lifecycle (fixture)");
const ds = await J("dev_start", { cwd: join(process.cwd(), "test/fixture") });
check("dev_start spawns the fixture", ds.running === true && ds.name === "devloop-fixture");
let fxUrl = "";
for (let i = 0; i < 40 && !fxUrl; i++) {
  await sleep(500);
  const sl = await J("get_logs", { source: "server", grep: "localhost", limit: 20 });
  fxUrl = sl.entries.map((e: any) => e.line.match(/http:\/\/localhost:\d+/)?.[0]).find(Boolean) ?? "";
}
check("fixture announced a localhost URL", !!fxUrl);
if (fxUrl) {
  await callText("browser_navigate", { url: fxUrl });
  await callText("browser_wait_for", { selector: "#go" });
  const fsnap = await J("browser_snapshot");
  check("fixture page snapshot has the Submit button", fsnap.nodes.some((n: any) => n.ref === "#go" && n.name === "Submit form"));
  await callText("browser_eval", { expression: "fetch('/api/boom').catch(()=>{})" });
  await sleep(600);
  const fnet = await J("get_logs", { stream: "network", limit: 30 });
  check("fixture /api/boom captured as 500 with body", fnet.entries.some((e: any) => (e.detail?.url ?? "").includes("/api/boom") && e.detail?.status === 500));

  // throttle: offline blocks a (local) fetch; none restores it
  await callText("browser_throttle", { profile: "offline" });
  const offl = await J("browser_eval", { expression: "fetch('/api/slow?ms=0').then(()=>'ok').catch(()=>'fail')" });
  check("throttle offline blocks fetch", offl.value === "fail");
  await callText("browser_throttle", { profile: "none" });
  const onl = await J("browser_eval", { expression: "fetch('/api/slow?ms=0').then(()=>'ok').catch(()=>'fail')" });
  check("throttle none restores fetch", onl.value === "ok");
}
await callText("dev_stop");

// --- summary ---
console.log(fails.length ? `\nSMOKE FAIL (${fails.length}): ${fails.join(", ")}` : `\nSMOKE OK (all checks passed)`);
await client.close();
process.exit(fails.length ? 1 : 0);
