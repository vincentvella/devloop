import { expect, test } from "bun:test";
import { LogBuffer } from "../src/logBuffer.ts";
import { configureTools, resolveTargets, type ToolDeps } from "../src/toolLayer.ts";

type Pane = { id: string; url: string; active: boolean; popped: boolean; label?: string };

/** Configure the tool layer with a fake pane manager (or single-pane when `panes` is null). */
function withPanes(panes: Pane[] | null): void {
  const browser =
    panes === null
      ? ({ kind: "web" } as never) // no listPanes → single-pane (stdio)
      : ({ kind: "web", listPanes: () => panes } as never);
  configureTools({ buffer: new LogBuffer(10), browser, devServer: {} as never } as unknown as ToolDeps);
}

const panes: Pane[] = [
  { id: "p1", url: "", active: true, popped: false, label: "Web" },
  { id: "p2", url: "", active: false, popped: false, label: "Caliburr" },
  { id: "p3", url: "", active: false, popped: false, label: "caliburr-admin" },
];

test("undefined app → undefined (no scoping)", () => {
  withPanes(panes);
  expect(resolveTargets(undefined)).toBeUndefined();
});

test("single-pane mode (no listPanes) → undefined", () => {
  withPanes(null);
  expect(resolveTargets("anything")).toBeUndefined();
});

test("exact label match wins over substring", () => {
  withPanes(panes);
  // "caliburr" exactly equals p2's label; p3 ("caliburr-admin") is only a substring → excluded.
  expect(resolveTargets("caliburr")).toEqual(["p2"]);
});

test("exact id match", () => {
  withPanes(panes);
  expect(resolveTargets("p1")).toEqual(["p1"]);
});

test("case-insensitive matching", () => {
  withPanes(panes);
  expect(resolveTargets("CALIBURR")).toEqual(["p2"]);
});

test("substring fallback matches all when there's no exact hit", () => {
  withPanes(panes);
  // "cali" matches no label/id exactly, so substring matches both p2 and p3.
  expect(resolveTargets("cali")).toEqual(["p2", "p3"]);
  // "admin" only appears in p3.
  expect(resolveTargets("admin")).toEqual(["p3"]);
});

test("no match → throws with a helpful message", () => {
  withPanes(panes);
  expect(() => resolveTargets("nonexistent")).toThrow(/no pane\/app matching/i);
});
