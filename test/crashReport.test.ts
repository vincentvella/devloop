import { test, expect } from "bun:test";
import { buildIssueUrl, blankIssueUrl, crashTitle, envLine, errorText, type CrashContext } from "../src/crashReport.ts";

const ctx: CrashContext = {
  kind: "main process",
  error: new Error("boom"),
  appVersion: "0.6.2",
  platform: "darwin",
  arch: "arm64",
  electronVersion: "42.5.0",
};

test("errorText prefers a stack, falls back to message/string/json", () => {
  expect(errorText(new Error("boom"))).toContain("boom");
  expect(errorText("plain")).toBe("plain");
  expect(errorText({ a: 1 })).toBe('{"a":1}');
});

test("crashTitle is one concise line tagged with the kind", () => {
  const title = crashTitle({ ...ctx, error: new Error("first line\nsecond line") });
  expect(title.startsWith("Crash (main process): ")).toBe(true);
  expect(title).toContain("first line");
  expect(title).not.toContain("second line");
});

test("envLine carries version + platform + electron", () => {
  expect(envLine(ctx)).toBe("0.6.2 · darwin arm64 · Electron 42.5.0");
});

test("buildIssueUrl targets the bug_report form with prefilled fields", () => {
  const u = new URL(buildIssueUrl(ctx));
  expect(u.origin + u.pathname).toBe("https://github.com/vincentvella/devloop/issues/new");
  expect(u.searchParams.get("template")).toBe("bug_report.yml");
  expect(u.searchParams.get("surface")).toBe("Electron cockpit");
  expect(u.searchParams.get("version")).toBe("0.6.2 · darwin arm64 · Electron 42.5.0");
  expect(u.searchParams.get("title")).toContain("Crash (main process)");
  expect(u.searchParams.get("logs")).toContain("boom");
});

test("buildIssueUrl truncates an oversized stack to stay under the URL ceiling", () => {
  const huge = new Error("big");
  huge.stack = "x".repeat(20000);
  const url = buildIssueUrl({ ...ctx, error: huge });
  expect(url.length).toBeLessThanOrEqual(6000);
  expect(decodeURIComponent(url)).toContain("truncated");
});

test("buildIssueUrl honors a custom repo", () => {
  expect(buildIssueUrl(ctx, "owner/repo")).toContain("https://github.com/owner/repo/issues/new");
});

test("blankIssueUrl prefills env but no crash fields", () => {
  const u = new URL(blankIssueUrl(ctx));
  expect(u.searchParams.get("template")).toBe("bug_report.yml");
  expect(u.searchParams.get("version")).toContain("0.6.2");
  expect(u.searchParams.get("logs")).toBeNull();
  expect(u.searchParams.get("title")).toBeNull();
});
