import { expect, test } from "bun:test";
import { defineTool } from "../src/defineTool.ts";

test("defineTool composes the description and generates the schema + required", () => {
  const t = defineTool({
    name: "x",
    purpose: "Do X.",
    behavior: "Returns Y.",
    alternatives: "Use Z instead.",
    annotations: { readOnlyHint: true },
    params: {
      a: { type: "string", description: "the a", required: true },
      b: { type: "number", description: "the b" },
      c: { type: "string", description: "the c", enum: ["one", "two"] },
    },
  });
  expect(t.name).toBe("x");
  expect(t.description).toBe("Do X. Returns Y. Use Z instead.");
  const props = t.inputSchema.properties as Record<string, { description: string; enum?: string[] }>;
  expect(props.a.description).toBe("the a");
  expect(props.c.enum).toEqual(["one", "two"]);
  expect(t.inputSchema.required).toEqual(["a"]);
  expect((t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint).toBe(true);
});

test("defineTool with no params yields empty properties and no required", () => {
  const t = defineTool({ name: "y", purpose: "Do Y over and over." });
  expect(t.inputSchema.properties).toEqual({});
  expect(t.inputSchema.required).toBeUndefined();
});
