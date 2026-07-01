import { expect, test } from "bun:test";
import { LogBuffer } from "../src/logBuffer.ts";
import { configureTools, handleTool, TOOLS, type ToolDeps } from "../src/toolLayer.ts";

const base = {
  buffer: new LogBuffer(10),
  browser: { kind: "web" } as never,
  devServer: {} as never,
} as unknown as ToolDeps;
const text = (r: { content: { text?: string }[] }) => r.content[0]!.text ?? "";

test("native_open / native_close / native_build are listed as MCP tools", () => {
  const names = TOOLS.map((t) => t.name);
  expect(names).toContain("native_open");
  expect(names).toContain("native_close");
  expect(names).toContain("native_build");
});

test("native_* report the cockpit is required when nativeControl is absent (stdio/daemon)", async () => {
  configureTools(base);
  await expect(handleTool("native_open", { platform: "ios" })).rejects.toThrow(/cockpit/i);
  await expect(handleTool("native_close", {})).rejects.toThrow(/cockpit/i);
  await expect(handleTool("native_build", { platform: "android" })).rejects.toThrow(/cockpit/i);
});

test("native_* delegate to nativeControl when configured (cockpit)", async () => {
  const calls: string[] = [];
  configureTools({
    ...base,
    nativeControl: {
      open: async (p) => {
        calls.push(`open:${p}`);
        return { ok: true };
      },
      close: async () => {
        calls.push("close");
      },
      build: async (p, cwd) => {
        calls.push(`build:${p}:${cwd ?? ""}`);
        return { started: true };
      },
    },
  });
  expect(JSON.parse(text(await handleTool("native_open", { platform: "android" }))).ok).toBe(true);
  await handleTool("native_close", {});
  expect(JSON.parse(text(await handleTool("native_build", { platform: "ios", cwd: "/proj" }))).started).toBe(true);
  expect(calls).toEqual(["open:android", "close", "build:ios:/proj"]);
});

test("native_doctor reports the cockpit is required in headless mode", async () => {
  configureTools(base);
  await expect(handleTool("native_doctor", {})).rejects.toThrow(/cockpit/i);
});

test("native_doctor returns the three readiness reports when configured", async () => {
  const report = (ready: boolean) => ({
    ready,
    checks: [{ label: "x", ok: ready }],
    summary: ready ? "ready" : "nope",
  });
  configureTools({
    ...base,
    nativeControl: {
      open: async () => ({ ok: true }),
      close: async () => {},
      build: async () => ({ started: true }),
      doctor: async () => ({ ios: report(true), androidInteractions: report(false), androidBuild: report(false) }),
    },
  });
  const r = JSON.parse(text(await handleTool("native_doctor", {})));
  expect(r.ios.ready).toBe(true);
  expect(r.androidBuild.ready).toBe(false);
  expect(r.androidInteractions.checks[0].label).toBe("x");
});
