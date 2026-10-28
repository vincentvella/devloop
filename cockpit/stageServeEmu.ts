/**
 * Stage serve-emu (Android streaming, see cockpit/serveEmu.ts) into the cockpit build.
 *
 * Its Node build only ships vendored inside `expo-device-hub`, with no package.json of
 * its own, and its two runtime deps live wherever the package manager put them (bun's
 * isolated store, or hoisted). So we assemble a self-contained copy:
 *
 *   <dest>/package.json                 {"type":"module"}: the dist is ESM
 *   <dest>/dist/…                       serve-emu itself
 *   <dest>/vendor/scrcpy-server-v4.0   the on-device server, checksum-pinned
 *   <dest>/node_modules/{@fastify/busboy,mediabunny}
 *
 * serve-emu downloads scrcpy-server on first use if it's missing, but a packaged app's
 * Resources are read-only (and writing there would break the macOS signature), so we
 * fetch it here, at build time, and verify it against scrcpy's published SHA-256.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The scrcpy-server serve-emu expects, and its SHA-256 from scrcpy's v4.0 SHA256SUMS.txt. */
export const SCRCPY_VERSION = "4.0";
export const SCRCPY_SHA256 = "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a";
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
const CACHE = join("node_modules", ".cache", "devloop", `scrcpy-server-v${SCRCPY_VERSION}`);

/** The vendored serve-emu inside the installed expo-device-hub. */
export function vendoredServeEmuDir(root = "."): string {
  return join(realpathSync(join(root, "node_modules", "expo-device-hub")), "vendor", "serve-emu");
}

/** The scrcpy-server version the vendored serve-emu was built against. */
export function vendoredScrcpyVersion(serveEmuDir: string): string | null {
  const src = readFileSync(join(serveEmuDir, "dist", "scrcpy-server.js"), "utf8");
  return /SCRCPY_VERSION = "([^"]+)"/.exec(src)?.[1] ?? null;
}

/** Find an installed package by walking up node_modules dirs from `fromDir`. */
function findPackage(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`stageServeEmu: can't find ${name} from ${fromDir}`);
  }
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** The pinned scrcpy-server bytes: from the cache, else downloaded. Throws on a checksum mismatch. */
async function scrcpyServer(): Promise<Buffer> {
  if (existsSync(CACHE)) {
    const cached = readFileSync(CACHE);
    if (sha256(cached) === SCRCPY_SHA256) return cached;
  }
  const res = await fetch(SCRCPY_URL);
  if (!res.ok) throw new Error(`stageServeEmu: downloading scrcpy-server failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== SCRCPY_SHA256) throw new Error(`stageServeEmu: scrcpy-server checksum mismatch (got ${got})`);
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, buf);
  return buf;
}

const noTypes = (src: string): boolean => !src.endsWith(".d.ts") && !src.endsWith(".map");

export async function stageServeEmu(dest: string): Promise<void> {
  const src = vendoredServeEmuDir();
  const expected = vendoredScrcpyVersion(src);
  if (expected !== SCRCPY_VERSION)
    throw new Error(
      `stageServeEmu: serve-emu wants scrcpy-server ${expected}, we pin ${SCRCPY_VERSION} — update SCRCPY_VERSION/SCRCPY_SHA256`,
    );

  mkdirSync(join(dest, "vendor"), { recursive: true });
  cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true, filter: noTypes });
  cpSync(join(src, "LICENSE"), join(dest, "LICENSE"));
  writeFileSync(join(dest, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);
  writeFileSync(join(dest, "vendor", `scrcpy-server-v${SCRCPY_VERSION}`), await scrcpyServer());

  // Runtime deps, trimmed to what Node loads (mediabunny's node ESM entry is dist/modules).
  const busboy = findPackage(src, "@fastify/busboy");
  const busboyDest = join(dest, "node_modules", "@fastify", "busboy");
  for (const f of ["package.json", "LICENSE", "index.js", "lib", "deps"])
    if (existsSync(join(busboy, f))) cpSync(join(busboy, f), join(busboyDest, f), { recursive: true });
  const mediabunny = findPackage(src, "mediabunny");
  const mbDest = join(dest, "node_modules", "mediabunny");
  for (const f of ["package.json", "LICENSE"]) cpSync(join(mediabunny, f), join(mbDest, f));
  cpSync(join(mediabunny, "dist", "modules"), join(mbDest, "dist", "modules"), { recursive: true, filter: noTypes });
}
