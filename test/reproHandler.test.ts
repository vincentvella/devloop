import { expect, mock, test } from "bun:test";
import { handleTool } from "../src/toolLayer.ts";
import { configure, makeBrowser, parse } from "./handleToolHarness.ts";

// All repro tests use 0ms settle waits so they don't actually sleep.
const fast = { settleMs: 0, stepSettleMs: 0, clear: false };

test("repro with neither `actions` nor `action` is an error result", async () => {
  configure();
  const r = await handleTool("repro", {});
  expect(r.isError).toBe(true);
  expect(r.content[0]?.text).toMatch(/requires `actions`/i);
});

test("single action: stepCount 1, actionResult set, no stop", async () => {
  const { browser } = configure();
  const r = parse(await handleTool("repro", { action: { kind: "navigate", url: "http://x/" }, ...fast }));
  expect(r.stepCount).toBe(1);
  expect(r.stoppedAtStep).toBeNull();
  expect(r.actionResult).toMatchObject({ url: "http://x/", status: 200 });
  expect(browser.navigate).toHaveBeenCalledWith("http://x/");
});

test("multi-step: every step runs when all succeed", async () => {
  configure();
  const r = parse(
    await handleTool("repro", {
      actions: [
        { kind: "navigate", url: "http://x/" },
        { kind: "click", selector: "#a" },
        { kind: "eval", expression: "1" },
      ],
      ...fast,
    }),
  );
  expect(r.stepCount).toBe(3);
  expect(r.stoppedAtStep).toBeNull();
  expect((r.steps as unknown[]).length).toBe(3);
});

test("a failing step stops the sequence (stoppedAtStep) when continueOnError is false", async () => {
  configure({
    browser: makeBrowser({
      click: mock(async () => {
        throw new Error("no such element");
      }),
    }),
  });
  const r = parse(
    await handleTool("repro", {
      actions: [
        { kind: "navigate", url: "http://x/" },
        { kind: "click", selector: "#x" },
        { kind: "eval", expression: "1" },
      ],
      ...fast,
    }),
  );
  expect(r.stoppedAtStep).toBe(1);
  expect(r.stepCount).toBe(2); // navigate + the failing click; eval never runs
});

test("continueOnError records the error but runs every step", async () => {
  configure({
    browser: makeBrowser({
      click: mock(async () => {
        throw new Error("no such element");
      }),
    }),
  });
  const r = parse(
    await handleTool("repro", {
      actions: [
        { kind: "navigate", url: "http://x/" },
        { kind: "click", selector: "#x" },
        { kind: "eval", expression: "1" },
      ],
      continueOnError: true,
      ...fast,
    }),
  );
  expect(r.stoppedAtStep).toBeNull();
  expect(r.stepCount).toBe(3);
  const steps = r.steps as Array<{ error?: string }>;
  expect(steps[1]?.error).toMatch(/no such element/);
});
