/**
 * Single source of truth for the cockpit's keyboard shortcuts — consumed by the
 * native menu bar (cockpit/main.ts, Electron accelerators) AND the in-app cheatsheet
 * overlay (cockpit/renderer, ⌘/). Each action id maps to a renderer handler; a menu
 * item fires it over IPC, the renderer keydown fires it directly.
 */

export interface Shortcut {
  /** Action id dispatched to the renderer (menu click → IPC, or window keydown). */
  id: string;
  /** Human label (menu item + cheatsheet row). */
  label: string;
  /** Electron accelerator (also parsed for the cheatsheet's key glyphs). */
  accel: string;
  /** Which menu it belongs under. */
  menu: "app" | "view" | "navigate" | "help";
}

export const SHORTCUTS: Shortcut[] = [
  { id: "settings", label: "Settings…", accel: "CmdOrCtrl+,", menu: "app" },
  { id: "focusUrl", label: "Focus address bar", accel: "CmdOrCtrl+L", menu: "view" },
  { id: "focusFilter", label: "Focus log filter", accel: "CmdOrCtrl+F", menu: "view" },
  { id: "clearLogs", label: "Clear logs", accel: "CmdOrCtrl+K", menu: "view" },
  { id: "reload", label: "Reload page", accel: "CmdOrCtrl+R", menu: "view" },
  { id: "hardReload", label: "Hard reload (ignore cache)", accel: "CmdOrCtrl+Shift+R", menu: "view" },
  { id: "toggleSidebar", label: "Toggle sidebar", accel: "CmdOrCtrl+B", menu: "view" },
  { id: "back", label: "Back", accel: "CmdOrCtrl+[", menu: "navigate" },
  { id: "forward", label: "Forward", accel: "CmdOrCtrl+]", menu: "navigate" },
  { id: "newPane", label: "New pane", accel: "CmdOrCtrl+T", menu: "navigate" },
  { id: "cheatsheet", label: "Keyboard shortcuts", accel: "CmdOrCtrl+/", menu: "help" },
];

/** Non-accelerator hint rows for the cheatsheet (handled in-renderer, not the menu). */
export const EXTRA_HINTS: { keys: string; label: string }[] = [{ keys: "⌘1–⌘9", label: "Select pane 1–9" }];

/** Map a lowercased keydown key (with the ⌘/Ctrl modifier already checked) to an action
 *  id — the renderer's window-level fallback for the same set (menu accelerators aside). */
export function keyToAction(key: string, shift: boolean): string | undefined {
  switch (key) {
    case "l":
      return "focusUrl";
    case "f":
      return "focusFilter";
    case "k":
      return "clearLogs";
    case "r":
      return shift ? "hardReload" : "reload";
    case "b":
      return "toggleSidebar";
    case ",":
      return "settings";
    case "/":
      return "cheatsheet";
    case "[":
      return "back";
    case "]":
      return "forward";
    case "t":
      return "newPane";
    default:
      return undefined;
  }
}

/** Render an Electron accelerator as compact key glyphs for the cheatsheet (mac style). */
export function prettyAccel(accel: string, isMac = true): string {
  return accel
    .split("+")
    .map((part) => {
      if (part === "CmdOrCtrl") return isMac ? "⌘" : "Ctrl";
      if (part === "Shift") return isMac ? "⇧" : "Shift";
      if (part === "Alt") return isMac ? "⌥" : "Alt";
      return part;
    })
    .join(isMac ? "" : "+");
}
