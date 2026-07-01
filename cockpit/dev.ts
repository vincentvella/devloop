/**
 * Dev runner for `bun run app`: build the cockpit, launch Electron, and on any
 * change under cockpit/ or src/, rebuild + relaunch Electron — so `out/` is never
 * stale (build.ts is one-shot; this loops it). `app:build`, `app:once`, and the
 * test runners stay one-shot. Ctrl-C stops the loop; closing the window also stops it.
 */
import { watch } from "node:fs";
import { createRequire } from "node:module";

const ELECTRON = createRequire(import.meta.url)("electron") as string; // path to the electron binary

let child: ReturnType<typeof Bun.spawn> | undefined;
let restarting = false; // true while WE kill Electron for a rebuild (vs the user closing the window)
let building = false;
let queued = false;

async function build(): Promise<boolean> {
  const p = Bun.spawn(["bun", "run", "cockpit/build.ts"], { stdout: "inherit", stderr: "inherit" });
  return (await p.exited) === 0;
}

function start(): void {
  restarting = false;
  child = Bun.spawn([ELECTRON, "out/main.cjs"], {
    stdout: "inherit",
    stderr: "inherit",
    onExit() {
      // Exited on its own (window closed) — not one of our rebuild restarts → stop the loop.
      if (!restarting) {
        process.stderr.write("[dev] app window closed — stopping the dev loop\n");
        process.exit(0);
      }
    },
  });
}

async function stop(): Promise<void> {
  const c = child;
  child = undefined;
  if (!c) return;
  restarting = true;
  c.kill("SIGTERM"); // graceful — main tears down panes, dev servers, and the HTTP server
  await Promise.race([c.exited, new Promise((r) => setTimeout(r, 2500))]);
  try {
    c.kill("SIGKILL"); // backstop if it didn't exit in time
  } catch {
    /* already gone */
  }
}

async function rebuild(): Promise<void> {
  if (building) {
    queued = true; // coalesce a burst of saves into one more pass
    return;
  }
  building = true;
  process.stderr.write("[dev] change detected — rebuilding…\n");
  if (await build()) {
    await stop();
    start();
    process.stderr.write("[dev] relaunched ✓\n");
  } else {
    process.stderr.write("[dev] build failed — keeping the running app; fix + save to retry\n");
  }
  building = false;
  if (queued) {
    queued = false;
    void rebuild();
  }
}

if (!(await build())) process.exit(1);
start();

let timer: ReturnType<typeof setTimeout> | undefined;
const onChange = (_event: string, file: string | null): void => {
  if (!file || file.endsWith("~") || file.includes("node_modules")) return;
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 150); // debounce editor save bursts
};
for (const dir of ["cockpit", "src"]) watch(dir, { recursive: true }, onChange);
process.stderr.write("[dev] watching cockpit/ + src/ — edit + save to rebuild & relaunch (Ctrl-C to stop)\n");

function shutdown(): void {
  void stop().then(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
