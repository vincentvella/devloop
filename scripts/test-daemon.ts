/**
 * Daemon integration test (#22): spawn the built daemon, connect TWO MCP clients over
 * HTTP/SSE, and prove they share ONE backend — the whole point of the daemon. Needs a
 * built dist/index.cjs + Chrome (the smoke CI job installs it).
 *
 *   bun run scripts/test-daemon.ts
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 7396;
const URL_ = `http://localhost:${PORT}/mcp`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails.push(name);
};

const daemon = spawn("node", ["dist/index.cjs", "daemon"], {
  env: { ...process.env, DEVLOOP_HTTP_PORT: String(PORT), DEVLOOP_HEADLESS: "true" },
  stdio: ["ignore", "ignore", "inherit"],
});

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL_)));
  return client;
}
const textOf = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

try {
  // Poll until the daemon is up + accepting MCP clients.
  let a: Client | undefined;
  for (let i = 0; i < 60 && !a; i++) {
    try {
      a = await connect("client-a");
    } catch {
      await sleep(500);
    }
  }
  check("daemon serves MCP over HTTP/SSE", !!a);
  if (!a) throw new Error("daemon never came up");

  const tools = await a.listTools();
  check(
    "tools/list over HTTP exposes the shared tool layer",
    tools.tools.some((t) => t.name === "browser_snapshot") && tools.tools.some((t) => t.name === "get_network"),
  );

  // A SECOND independent client connects to the same daemon.
  const b = await connect("client-b");
  check("a second client connects to the same daemon", !!b);

  // Shared backend: client A drives the browser; client B sees the result on the timeline.
  await a.callTool({ name: "clear_logs", arguments: {} });
  await a.callTool({
    name: "browser_navigate",
    arguments: { url: "data:text/html,<script>console.log('daemon-shared-marker')</script>" },
  });
  await sleep(900);
  const seenByB = textOf(
    (await b.callTool({ name: "get_logs", arguments: { grep: "daemon-shared-marker", limit: 50 } })) as {
      content: { text?: string }[];
    },
  );
  check(
    "a second client sees the first client's browser activity (shared backend)",
    seenByB.includes("daemon-shared-marker"),
    seenByB.slice(0, 80),
  );

  // clear_logs from A is visible to B too (one buffer, not per-session).
  await a.callTool({ name: "clear_logs", arguments: {} });
  await sleep(200);
  const afterClear = textOf(
    (await b.callTool({ name: "get_logs", arguments: { grep: "daemon-shared-marker", limit: 50 } })) as {
      content: { text?: string }[];
    },
  );
  check("clear_logs from one client clears the shared timeline", !afterClear.includes("daemon-shared-marker"));

  await a.close();
  await b.close();
} finally {
  daemon.kill();
}

console.log(fails.length ? `\nDAEMON FAIL (${fails.length}): ${fails.join(", ")}` : "\nDAEMON OK (all checks passed)");
process.exit(fails.length ? 1 : 0);
