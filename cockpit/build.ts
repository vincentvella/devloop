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
  Bun.build({ entrypoints: ["cockpit/simPreload.ts"], outdir: "out", naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/extStorePreload.ts"], outdir: "out", naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/renderer/main.tsx"], outdir: "out/renderer", target: "browser" }),
]);

for (const r of results) {
  if (!r.success) {
    for (const log of r.logs) console.error(log);
    process.exit(1);
  }
}

cpSync("cockpit/renderer/index.html", "out/renderer/index.html");

// electron-chrome-web-store's webstorePrivate preload. The lib is bundled into
// main.cjs, so its own `import.meta.dirname`-based resolution lands on a source path
// that doesn't exist (logs "Unable to load preload script" in every pane). We pass
// `modulePath: BASE` in main.ts, which makes it look at `<BASE>/dist/<file>` — so the
// copy must live under out/dist/.
mkdirSync("out/dist", { recursive: true });
cpSync(
  "node_modules/electron-chrome-web-store/dist/chrome-web-store.preload.js",
  "out/dist/chrome-web-store.preload.js",
);

// Compile Tailwind → out/renderer/styles.css
const tw = Bun.spawnSync([
  "bunx",
  "@tailwindcss/cli",
  "-i",
  "cockpit/renderer/styles.css",
  "-o",
  "out/renderer/styles.css",
  "--minify",
]);
if (tw.exitCode !== 0) {
  console.error(new TextDecoder().decode(tw.stderr));
  process.exit(1);
}

console.log("built cockpit → out/ (main.cjs, preload.cjs, renderer/, styles.css)");
