/**
 * Print a TDQS-style audit of every tool (schema coverage, annotations, issues).
 * `bun run tools:audit`. The bun:test gate (test/toolQuality.test.ts) enforces
 * these in CI; this is the human-readable view.
 */
import { TOOLS } from "../src/toolLayer.ts";
import { auditTools } from "../src/tdqs.ts";

const audits = auditTools(TOOLS).sort((a, b) => a.coverage - b.coverage || a.name.localeCompare(b.name));
let problems = 0;
for (const a of audits) {
  const cov = `${Math.round(a.coverage * 100)}%`.padStart(4);
  const ann = a.hasAnnotations ? "ann" : " — ";
  const flag = a.issues.length ? "✗" : "✓";
  process.stdout.write(`${flag} ${a.name.padEnd(24)} params ${String(a.documentedParams)}/${String(a.paramCount)}  coverage ${cov}  ${ann}\n`);
  for (const i of a.issues) {
    problems++;
    process.stdout.write(`    - ${i}\n`);
  }
}
process.stdout.write(`\n${audits.length} tools, ${problems} issue(s)\n`);
process.exit(problems ? 1 : 0);
