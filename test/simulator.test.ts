import { expect, test } from "bun:test";
import { shouldShowSimulator, simulatorBounds, serveSimSpawn, SERVE_SIM_URL, simulatorViewerHtml, streamUrlFromApi, simInfoFromApi } from "../src/simulator.ts";

test("shouldShowSimulator: visible only when active + no overlay + window shown", () => {
  expect(shouldShowSimulator({ isActiveView: true, overlayOpen: false, windowVisible: true })).toBe(true);
  // any one falsy → hidden
  expect(shouldShowSimulator({ isActiveView: false, overlayOpen: false, windowVisible: true })).toBe(false);
  expect(shouldShowSimulator({ isActiveView: true, overlayOpen: true, windowVisible: true })).toBe(false); // modal up
  expect(shouldShowSimulator({ isActiveView: true, overlayOpen: false, windowVisible: false })).toBe(false); // minimized
});

test("simulatorBounds offsets the pane rect by the content origin + rounds", () => {
  const content = { x: 100, y: 50, width: 1280, height: 820 };
  const pane = { x: 40.4, y: 90.6, width: 300.2, height: 650.8 };
  expect(simulatorBounds(content, pane)).toEqual({ x: 140, y: 141, width: 300, height: 651 });
});

test("simulatorBounds clamps a zero/negative rect to a sane minimum", () => {
  const b = simulatorBounds({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 });
  expect(b.width).toBe(1);
  expect(b.height).toBe(1);
});

test("serveSimSpawn: bunx by default, npx fallback", () => {
  expect(serveSimSpawn()).toEqual({ cmd: "bunx", args: ["serve-sim", "--port", "3200"] });
  expect(serveSimSpawn("npx")).toEqual({ cmd: "npx", args: ["-y", "serve-sim", "--port", "3200"] });
  expect(SERVE_SIM_URL).toBe("http://localhost:3200/");
});

test("simulatorViewerHtml embeds the stream URL as an <img> data: page", () => {
  const url = simulatorViewerHtml("http://127.0.0.1:3100/stream.mjpeg");
  expect(url.startsWith("data:text/html")).toBe(true);
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  expect(html).toContain('<img src="http://127.0.0.1:3100/stream.mjpeg"');
  expect(html).toContain("object-fit:contain");
});

test("streamUrlFromApi extracts a valid stream URL, else null", () => {
  expect(streamUrlFromApi({ streamUrl: "http://127.0.0.1:3100/stream.mjpeg" })).toBe("http://127.0.0.1:3100/stream.mjpeg");
  expect(streamUrlFromApi({})).toBeNull();
  expect(streamUrlFromApi(null)).toBeNull();
  expect(streamUrlFromApi({ streamUrl: "garbage" })).toBeNull();
});

test("simInfoFromApi extracts device + url (for preview mode), else null", () => {
  expect(simInfoFromApi({ device: "UDID", url: "http://127.0.0.1:3100" })).toEqual({ device: "UDID", url: "http://127.0.0.1:3100" });
  expect(simInfoFromApi({ device: "UDID" })).toBeNull();
  expect(simInfoFromApi({ url: "http://127.0.0.1:3100" })).toBeNull();
  expect(simInfoFromApi(null)).toBeNull();
});
