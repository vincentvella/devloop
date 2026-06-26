/**
 * Typed tool authoring (#round2.6b) — define a tool from structured fields and
 * GENERATE its MCP description + JSON inputSchema. The point: per-parameter
 * descriptions are REQUIRED by the type, so schema coverage is 100% by
 * construction (you can't compile an undocumented param) — the TDQS Parameter
 * Semantics lever, enforced at author time instead of only in the CI gate.
 *
 * The structured prose fields map to the TDQS rubric dimensions:
 *   purpose      → Purpose Clarity (verb + resource; leads the description)
 *   behavior     → Behavioral Transparency / Contextual Completeness
 *   whenToUse    → Usage Guidelines (when to / when not to)
 *   alternatives → Usage Guidelines (the sibling tool to use instead, by name)
 *   annotations  → Behavioral Transparency (readOnly/destructive/idempotent/openWorld)
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ParamSpec {
  type: "string" | "number" | "boolean" | "array" | "object";
  /** REQUIRED — what the value means, beyond the param name (raises schema coverage). */
  description: string;
  /** Mark the parameter required. */
  required?: boolean;
  /** Allowed values (also helps coverage). */
  enum?: readonly string[];
  /** Raw JSON Schema for array items / object properties — escape hatch for nested shapes. */
  items?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  /** Specific verb + resource that distinguishes it from peers. Leads the generated description. */
  purpose: string;
  /** Side effects + what it returns. */
  behavior?: string;
  /** When to use it (and when not to). */
  whenToUse?: string;
  /** Which sibling tool to reach for instead, named explicitly. */
  alternatives?: string;
  annotations?: ToolAnnotations;
  params?: Record<string, ParamSpec>;
}

/** Build an MCP Tool (description + inputSchema) from a structured spec. */
export function defineTool(spec: ToolSpec): Tool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(spec.params ?? {})) {
    properties[name] = {
      type: p.type,
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.items ? { items: p.items } : {}),
      ...(p.properties ? { properties: p.properties } : {}),
    };
    if (p.required) required.push(name);
  }
  const description = [spec.purpose, spec.behavior, spec.whenToUse, spec.alternatives]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join(" ");
  return {
    name: spec.name,
    description,
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
  } as Tool;
}
