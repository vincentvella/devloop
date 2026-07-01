/**
 * Cockpit build — bundles the Electron main, preload, and renderer with Bun.
 * Run via `bun run app:build`. Electron itself is left external (provided by the
 * runtime); everything else (MCP SDK, shared src/ core) is bundled in.
 *
 * Builds into a pid-unique staging dir and **atomically swaps** it into `out/` at
 * the end (two renames — µs window — not an in-place ~1-2s rebuild). So a running
 * app or the `bun run app` watcher never loads a half-written `out/` (which flashes
 * unstyled), concurrent builds don't race, and a failed build leaves `out/` intact.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

const STAGE = `out.next.${process.pid}`; // pid-unique so concurrent builds never collide
const PREV = `out.prev.${process.pid}`;

/** Drop the staging dir and exit non-zero, leaving the existing out/ untouched. */
function fail(msg?: string): never {
  if (msg) console.error(msg);
  rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(`${STAGE}/renderer`, { recursive: true });

const node = { target: "node", format: "cjs", external: ["electron"] } as const;

const results = await Promise.all([
  Bun.build({ entrypoints: ["cockpit/main.ts"], outdir: STAGE, naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/preload.ts"], outdir: STAGE, naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/simPreload.ts"], outdir: STAGE, naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/extStorePreload.ts"], outdir: STAGE, naming: "[name].cjs", ...node }),
  Bun.build({ entrypoints: ["cockpit/renderer/main.tsx"], outdir: `${STAGE}/renderer`, target: "browser" }),
]);

for (const r of results) {
  if (!r.success) {
    for (const log of r.logs) console.error(log);
    fail();
  }
}

cpSync("cockpit/renderer/index.html", `${STAGE}/renderer/index.html`);

// electron-chrome-web-store's webstorePrivate preload. The lib is bundled into
// main.cjs, so its own `import.meta.dirname`-based resolution lands on a source path
// that doesn't exist (logs "Unable to load preload script" in every pane). We pass
// `modulePath: BASE` in main.ts, which makes it look at `<BASE>/dist/<file>` — so the
// copy must live under out/dist/.
mkdirSync(`${STAGE}/dist`, { recursive: true });
cpSync(
  "node_modules/electron-chrome-web-store/dist/chrome-web-store.preload.js",
  `${STAGE}/dist/chrome-web-store.preload.js`,
);
// That preload is a CommonJS bundle (a `require` shim, no import.meta). Our app
// package.json is `"type": "module"`, so a bare `.js` would load as ESM — and the
// shim then throws "Dynamic require of electron is not supported" in every pane.
// A type:commonjs marker beside it forces CJS so its require() works.
writeFileSync(`${STAGE}/dist/package.json`, JSON.stringify({ type: "commonjs" }) + "\n");

// Compile Tailwind → <stage>/renderer/styles.css
const tw = Bun.spawnSync([
  "bunx",
  "@tailwindcss/cli",
  "-i",
  "cockpit/renderer/styles.css",
  "-o",
  `${STAGE}/renderer/styles.css`,
  "--minify",
]);
if (tw.exitCode !== 0) fail(new TextDecoder().decode(tw.stderr));

// Atomic swap: replace out/ via renames (µs window) instead of an in-place rebuild,
// so a running app / the watcher never sees a partial out/. PREV is pid-unique so
// two concurrent swaps don't step on each other.
rmSync(PREV, { recursive: true, force: true });
if (existsSync("out")) renameSync("out", PREV);
renameSync(STAGE, "out");
rmSync(PREV, { recursive: true, force: true });

console.log("built cockpit → out/ (main.cjs, preload.cjs, renderer/, styles.css)");
