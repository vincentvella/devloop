/**
 * Core self-test steps: substrate→buffer flow, the tool layer over Electron, the
 * MCP-over-HTTP surface, the renderer IPC path, and the project registry.
 */
import type { Check, SelftestCtx } from "./context.ts";

export async function coreSteps(ctx: SelftestCtx): Promise<Check[]> {
  const { manager, buffer, handleTool, shellWin, chosenPort, tick } = ctx;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  tick("substrate→buffer");
  // 1) substrate -> buffer (console object rendered synchronously from CDP)
  await manager.navigate(
    `data:text/html,<button id=go onclick="console.log('cockpit', {ok:true})">go</button><script>console.log('hi', {n:1});fetch('http://localhost:59999/x').catch(()=>{})</script>`,
  );
  await new Promise((r) => setTimeout(r, 600));
  const logs = buffer.query({ source: "browser" });
  console.log("SELFTEST buffer (browser):");
  for (const e of logs) console.log(`  [${e.stream}] ${e.line}`);

  tick("tool layer (electron)");
  // 2) tool layer over the Electron substrate
  const clickRes = await handleTool("repro", {
    action: { kind: "click", selector: "#go" },
    settleMs: 300,
    clear: false,
  });
  const clicked = JSON.parse((clickRes.content[0] as { text: string }).text);
  console.log(`SELFTEST repro click: stepCount=${clicked.stepCount} errorCount=${clicked.errorCount}`);

  tick("mcp-over-http");
  // 3) MCP over HTTP — the real remote-Claude surface: handshake, tools/list, AND run a repro.
  const client = new Client({ name: "selftest", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${chosenPort}/mcp`)));
  const t = await client.listTools();
  console.log(`SELFTEST MCP/HTTP tools: ${t.tools.length} (${t.tools.map((x) => x.name).join(", ")})`);

  // Set up and run a repro entirely over MCP-over-HTTP, then read it back.
  const reproRes = (await client.callTool({
    name: "repro",
    arguments: {
      action: {
        kind: "navigate",
        url: `data:text/html,<script>console.error('mcp-repro-err');fetch('http://localhost:${chosenPort}/nope').catch(()=>{})</script>`,
      },
      waitFor: "networkidle",
      idleMs: 400,
      timeoutMs: 5000,
    },
  })) as { content: Array<{ type: string; text?: string }> };
  const reproData = JSON.parse(reproRes.content.find((c) => c.type === "text")!.text!) as {
    stepCount: number;
    errorCount: number;
    errors: { line: string }[];
  };
  const mcpReproOk = reproData.stepCount === 1 && reproData.errorCount >= 1;
  console.log(`SELFTEST MCP repro: steps=${reproData.stepCount} errors=${reproData.errorCount} ok=${mcpReproOk}`);
  await client.close();

  tick("renderer path");
  // 4) RENDERER path: preload API present, and a renderer-initiated navigate reaches the buffer
  const tl = shellWin.webContents;
  for (let i = 0; i < 50 && tl.isLoading(); i++) await new Promise((r) => setTimeout(r, 100));
  const api = await tl.executeJavaScript("typeof window.devloop");
  const methods = await tl.executeJavaScript("window.devloop ? Object.keys(window.devloop).join(',') : 'NONE'");
  console.log(`SELFTEST renderer api=${api} methods=${methods}`);
  const navJson = await tl.executeJavaScript(
    "window.devloop.navigate('data:text/html,<script>console.log(\\'from-renderer-nav\\')</script>').then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e.message)",
  );
  console.log(`SELFTEST renderer navigate -> ${navJson}`);
  await new Promise((r) => setTimeout(r, 400));
  const got = buffer.query({}).some((e) => e.line.includes("from-renderer-nav"));
  console.log(`SELFTEST renderer->buffer flowed: ${got}`);

  tick("project registry");
  // 5) project registry: add via tool layer, confirm tool + renderer both see it
  await handleTool("project_add", { name: "selftest-proj", cwd: process.cwd(), url: "about:blank" });
  const plist = JSON.parse((await handleTool("project_list")).content[0]!.text as string) as {
    projects: { name: string }[];
  };
  const inTool = plist.projects.some((p) => p.name === "selftest-proj");
  const rendererSees = (await tl.executeJavaScript(
    "window.devloop.projects().then(ps=>ps.map(p=>p.name).join(','))",
  )) as string;
  console.log(`SELFTEST registry: tool=${inTool} rendererSees="${rendererSees}"`);

  return [
    ["renderer api present", api === "object"],
    ["mcp-over-http repro", mcpReproOk],
    ["renderer→buffer flow", got],
    ["in-process tool call", inTool],
    ["registry visible to renderer", rendererSees.includes("selftest-proj")],
  ];
}
