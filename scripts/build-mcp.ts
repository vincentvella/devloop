/**
 * Bundle the stdio MCP (src/index.ts) into a single node-runnable file for npm.
 * Everything is bundled except puppeteer (a runtime dependency that ships its own
 * Chromium). Output gets a `#!/usr/bin/env node` shebang so `npx devloop-mcp` works
 * without bun installed.
 */
import { rmSync, chmodSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "cjs",
  naming: "index.cjs",
  external: ["puppeteer"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Replace any bundled shebang with a node one (a `#!` line is only valid as line 1).
const out = "dist/index.cjs";
const body = (await Bun.file(out).text()).replace(/^#!.*\n/, "");
await Bun.write(out, `#!/usr/bin/env node\n${body}`);
chmodSync(out, 0o755);

console.log("built stdio MCP → dist/index.cjs (node-runnable)");
