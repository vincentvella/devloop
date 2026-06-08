/**
 * Cockpit build — bundles the Electron main, preload, and renderer with Bun.
 * Run via `bun run app:build`. Electron itself is left external (provided by the
 * runtime); everything else (MCP SDK, shared src/ core) is bundled in.
 */
import { rmSync, mkdirSync, cpSync } from "node:fs";

rmSync("out", { recursive: true, force: true });
mkdirSync("out/renderer", { recursive: true });

const node = { target: "node", format: "cjs", external: ["electron"] } as const;

const results = await Promise.all([
  Bun.build({ entrypoints: ["cockpit/main.ts"], outdir: "out", naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/preload.ts"], outdir: "out", naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/renderer/timeline.ts"], outdir: "out/renderer", target: "browser" }),
]);

for (const r of results) {
  if (!r.success) {
    for (const log of r.logs) console.error(log);
    process.exit(1);
  }
}

cpSync("cockpit/renderer/index.html", "out/renderer/index.html");
console.log("built cockpit → out/ (main.cjs, preload.cjs, renderer/)");
