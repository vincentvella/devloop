/**
 * Tool Definition Quality Score (TDQS) — the *mechanical* signals from Glama's
 * rubric (https://github.com/glama-ai/tool-definition-quality-score), so we can
 * lint tool definitions in CI instead of finding out from a third-party re-score.
 *
 * We can't grade the prose dimensions (Purpose/Usage/Behavior wording) in code,
 * but we CAN enforce the levers the rubric rewards mechanically:
 *  - Parameter Semantics: schema coverage = params-with-descriptions / params.
 *    >80% earns the baseline; we require 100%.
 *  - Behavioral Transparency: MCP annotations (readOnly/destructive/idempotent/
 *    openWorld hints) reduce the disclosure burden — require at least one.
 *  - Conciseness/Completeness: a description that isn't trivially short.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolAudit {
  name: string;
  paramCount: number;
  documentedParams: number;
  /** params-with-descriptions / total params (1 when there are no params). */
  coverage: number;
  hasAnnotations: boolean;
  descriptionLength: number;
  issues: string[];
}

const MIN_PARAM_DESC = 3;
const MIN_TOOL_DESC = 30;

/** Audit one tool against the mechanical TDQS rules. */
export function auditTool(tool: Tool): ToolAudit {
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, { description?: string }>;
  const names = Object.keys(props);
  const documented = names.filter((n) => (props[n]?.description?.trim().length ?? 0) >= MIN_PARAM_DESC);
  const coverage = names.length === 0 ? 1 : documented.length / names.length;

  const ann = (tool as { annotations?: Record<string, unknown> }).annotations;
  const hasAnnotations = !!ann && Object.keys(ann).some((k) => k.endsWith("Hint"));

  const desc = tool.description ?? "";
  const issues: string[] = [];
  for (const n of names) if (!documented.includes(n)) issues.push(`param "${n}" is missing a description`);
  if (!hasAnnotations) issues.push("no MCP annotations (set a readOnly/destructive/idempotent/openWorld hint)");
  if (desc.trim().length < MIN_TOOL_DESC) issues.push(`description is too short (<${MIN_TOOL_DESC} chars)`);
  return {
    name: tool.name,
    paramCount: names.length,
    documentedParams: documented.length,
    coverage,
    hasAnnotations,
    descriptionLength: desc.length,
    issues,
  };
}

export const auditTools = (tools: Tool[]): ToolAudit[] => tools.map(auditTool);
