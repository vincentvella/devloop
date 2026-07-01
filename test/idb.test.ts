import { expect, test } from "bun:test";
import {
  idbButtonArgs,
  idbDescribeAllArgs,
  idbKeyArgs,
  idbSwipeArgs,
  idbTapArgs,
  idbTextArgs,
  keycodeFor,
  parseDescribeAll,
  pointFromRef,
  pointRef,
} from "../src/idb.ts";

const UDID = "763E2D1D-7A24-447F-93AE-290FE2333E0D";

test("point ref round-trips (rounded)", () => {
  expect(pointRef(100.4, 50.6)).toBe("pt:100,51");
  expect(pointFromRef("pt:100,51")).toEqual({ x: 100, y: 51 });
  expect(pointFromRef("pt:12,34")).toEqual({ x: 12, y: 34 });
  expect(pointFromRef("button.foo")).toBeNull();
  expect(pointFromRef("garbage")).toBeNull();
});

test("idb arg builders", () => {
  expect(idbTapArgs(UDID, 100.6, 200)).toEqual(["ui", "tap", "--udid", UDID, "101", "200"]);
  expect(idbTextArgs(UDID, "hello")).toEqual(["ui", "text", "--udid", UDID, "hello"]);
  expect(idbSwipeArgs(UDID, 200, 600, 200, 200)).toEqual(["ui", "swipe", "--udid", UDID, "200", "600", "200", "200"]);
  expect(idbSwipeArgs(UDID, 200, 600, 200, 200, 500)).toEqual([
    "ui",
    "swipe",
    "--udid",
    UDID,
    "200",
    "600",
    "200",
    "200",
    "--duration",
    "0.5",
  ]);
  expect(idbKeyArgs(UDID, 40)).toEqual(["ui", "key", "--udid", UDID, "40"]);
  expect(idbButtonArgs(UDID, "HOME")).toEqual(["ui", "button", "HOME", "--udid", UDID]);
  expect(idbDescribeAllArgs(UDID)).toEqual(["ui", "describe-all", "--udid", UDID, "--json"]);
});

test("keycodeFor maps the press keys, null otherwise", () => {
  expect(keycodeFor("Enter")).toBe(40);
  expect(keycodeFor("Backspace")).toBe(42);
  expect(keycodeFor("ArrowDown")).toBe(81);
  expect(keycodeFor("F13")).toBeNull();
});

test("parseDescribeAll builds a snapshot with center-point refs", () => {
  const json = JSON.stringify([
    { frame: { x: 0, y: 0, width: 390, height: 844 }, type: "Application", AXLabel: "root" }, // root container → dropped
    { frame: { x: 16, y: 100, width: 358, height: 44 }, type: "Button", AXLabel: "Sign in", enabled: true },
    { frame: { x: 16, y: 160, width: 358, height: 40 }, type: "TextField", AXLabel: "Email", AXValue: "a@b.com" },
    { frame: { x: 16, y: 220, width: 358, height: 20 }, type: "StaticText", AXLabel: "Welcome back" },
    { frame: { x: 0, y: 0, width: 0, height: 0 }, type: "Other", AXLabel: "zero" }, // zero-size → dropped
    { frame: { x: 16, y: 300, width: 100, height: 30 }, type: "Other" }, // unnamed non-interactive → dropped
  ]);
  const snap = parseDescribeAll(json, {
    url: "Caliburr",
    title: "Caliburr",
    screen: { x: 0, y: 0, width: 390, height: 844 },
  });
  expect(snap.url).toBe("Caliburr");
  expect(snap.nodes.map((n) => n.name)).toEqual(["Sign in", "Email", "Welcome back"]);
  expect(snap.nodes[0]).toEqual({ ref: "pt:195,122", role: "Button", name: "Sign in", tag: "native" });
  // TextField keeps its value, dropped root + zero + unnamed-other.
  expect(snap.nodes[1]).toMatchObject({ ref: "pt:195,180", role: "TextField", name: "Email", value: "a@b.com" });
});

test("parseDescribeAll tolerates bad input", () => {
  expect(parseDescribeAll("not json").nodes).toEqual([]);
  expect(parseDescribeAll("{}").nodes).toEqual([]);
  expect(parseDescribeAll("[]").nodes).toEqual([]);
});
