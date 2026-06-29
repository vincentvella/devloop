/**
 * Single source of truth for the version Devloop advertises to MCP clients —
 * read straight from package.json so it can never drift from the published version.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
