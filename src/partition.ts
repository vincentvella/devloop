/**
 * Per-project session partitions (#27). All panes used to share one Electron session
 * (`persist:devloop-panes`), so two different apps served on the same origin (e.g. both
 * on localhost:3000) shared cookies/localStorage/IndexedDB — a real footgun. We instead
 * key the partition on the project's working directory: panes for the same project share
 * storage (correct — it's one app), different projects are isolated.
 *
 * Electron partitions are immutable per WebContentsView, so a pane's view is recreated
 * when its cwd changes. The mapping is deterministic (cwd → hash), so disk-backed
 * `persist:` storage survives restarts without persisting the partition name separately.
 */
import { createHash } from "node:crypto";

/** The shared session for panes with no project bound (and the Web Store window). */
export const DEFAULT_PARTITION = "persist:devloop-panes";

/** Normalize a cwd so trivial differences (trailing slash, whitespace) map to one project. */
export function normalizeCwd(cwd: string): string {
  return cwd.trim().replace(/[/\\]+$/, "");
}

/**
 * Stable partition for a project cwd: `persist:devloop-proj-<hash>`. Empty/undefined
 * cwd → the default shared partition (unchanged legacy behavior).
 */
export function partitionForCwd(cwd: string | undefined | null): string {
  const norm = cwd ? normalizeCwd(cwd) : "";
  if (!norm) return DEFAULT_PARTITION;
  const hash = createHash("sha1").update(norm).digest("hex").slice(0, 12);
  return `persist:devloop-proj-${hash}`;
}
