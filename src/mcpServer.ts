/**
 * The MCP Server wiring, shared by every transport: stdio (src/index.ts), the
 * headless daemon (src/daemon.ts), and the Electron cockpit (cockpit/main.ts).
 * All of them expose the same TOOLS + handleTool over their respective transport;
 * this keeps that one definition in one place.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, handleTool } from "./toolLayer.ts";

/** Build an MCP Server bound to the shared tool layer (errors returned as isError results). */
export function buildMcpServer(name = "devloop-mcp", version = "0.5.1"): Server {
  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: tool, arguments: args = {} } = req.params;
    try {
      return await handleTool(tool, args as Record<string, unknown>);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `${tool} failed: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  });
  return server;
}
