/**
 * TDQS gate — every tool definition must clear the mechanical rubric rules
 * (per-param descriptions, MCP annotations, non-trivial description). A new tool
 * with an undocumented param or a missing hint fails CI here. See src/tdqs.ts.
 */
import { test, expect } from "bun:test";
import { TOOLS } from "../src/toolLayer.ts";
import { auditTool } from "../src/tdqs.ts";

for (const tool of TOOLS) {
  test(`TDQS: ${tool.name}`, () => {
    const audit = auditTool(tool);
    if (audit.issues.length) {
      throw new Error(`${tool.name} fails TDQS rules:\n  - ${audit.issues.join("\n  - ")}`);
    }
    expect(audit.coverage).toBe(1);
    expect(audit.hasAnnotations).toBe(true);
  });
}
