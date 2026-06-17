/**
 * Chrome extension helpers (pure). Chrome extension IDs are 32 chars in [a-p].
 * Accepts a raw id or a Chrome Web Store URL and extracts the id.
 */
export function extensionIdFromInput(input: string): string | null {
  const matches = [...input.trim().matchAll(/[a-p]{32}/g)];
  return matches.length ? matches[matches.length - 1]![0] : null; // last 32-char id segment
}

export interface ExtMeta {
  id: string;
  name: string;
  version: string;
}
export interface ExtListItem extends ExtMeta {
  enabled: boolean;
}

/**
 * Merge the session's loaded extensions with known-but-disabled ones into a
 * single list the UI can render with on/off toggles. Loaded → enabled; disabled
 * (not loaded, read from disk) → disabled. Sorted by name; loaded wins on dupes.
 */
export function unifyExtensions(loaded: ExtMeta[], disabled: ExtMeta[]): ExtListItem[] {
  const out: ExtListItem[] = loaded.map((e) => ({ ...e, enabled: true }));
  for (const d of disabled) if (!out.some((e) => e.id === d.id)) out.push({ ...d, enabled: false });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
