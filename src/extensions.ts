/**
 * Chrome extension helpers (pure). Chrome extension IDs are 32 chars in [a-p].
 * Accepts a raw id or a Chrome Web Store URL and extracts the id.
 */
export function extensionIdFromInput(input: string): string | null {
  const matches = [...input.trim().matchAll(/[a-p]{32}/g)];
  return matches.length ? matches[matches.length - 1]![0] : null; // last 32-char id segment
}
