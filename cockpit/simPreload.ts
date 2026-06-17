/**
 * Preload for the simulator WebContentsView. Runs before serve-sim's bundle and:
 *   1. Nulls VideoDecoder so serve-sim uses its MJPEG <img> path instead of the
 *      avcc <canvas> — an <img> composites in a WebContentsView; a GPU canvas
 *      does not.
 *   2. Sets window.__SIM_PREVIEW__ = { device, url } to trigger serve-sim's
 *      interactive preview/embed mode (device frame + input layer, no chrome).
 *
 * Device + url come from serve-sim's /api, passed via webPreferences.additional-
 * Arguments. Runs in the page world (contextIsolation:false) so the globals stick.
 */
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
const device = arg("--sim-device");
const url = arg("--sim-url");

try {
  Object.defineProperty(globalThis, "VideoDecoder", { value: undefined, configurable: true });
} catch {
  /* ignore */
}
if (device && url) {
  (globalThis as unknown as { __SIM_PREVIEW__?: unknown }).__SIM_PREVIEW__ = { device, url };
}
