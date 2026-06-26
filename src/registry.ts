/**
 * Project registry — a small persisted list of projects so you pick a saved
 * project by name instead of retyping cmd/cwd every time. Backed by a JSON file
 * (default ~/.devloop/projects.json; override with DEVLOOP_HOME). Pure Node, no
 * Electron — shared by the stdio server and the cockpit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ReproStep {
  kind: string;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
}

export interface Project {
  name: string;
  cwd: string;
  /** Dev command; if omitted, auto-detected from package.json at start time. */
  cmd?: string;
  /** Default URL to open in the browser pane. */
  url?: string;
  /** Saved repro action sequence for this project. */
  steps?: ReproStep[];
}

/** Last-used setup, restored when the cockpit reopens (no name required). */
export interface Session {
  cmd?: string;
  cwd?: string;
  url?: string;
  steps?: ReproStep[];
  /** Last-selected project + save-as name in the cockpit form. */
  project?: string;
  pname?: string;
}

/** Open panes (url + project label + dev config) so the cockpit restores them on relaunch. */
export interface PanesState {
  panes: { url: string; label?: string; cmd?: string; cwd?: string }[];
  activeIndex?: number;
}

// Read DEVLOOP_HOME lazily (not at module load) so it's honored regardless of import
// order — e.g. a test that sets it after importing a module which transitively loads this.
const dir = (): string => process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop");
const file = (name: string): string => join(dir(), name);

export function listProjects(): Project[] {
  try {
    const parsed = JSON.parse(readFileSync(file("projects.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // no file yet
  }
}

export function getProject(name: string): Project | undefined {
  return listProjects().find((p) => p.name === name);
}

function saveAll(projects: Project[]): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file("projects.json"), JSON.stringify(projects, null, 2));
}

/** Add or replace a project by name. Returns the full list. */
export function addProject(p: Project): Project[] {
  if (!p.name || !p.cwd) throw new Error("project requires name and cwd");
  const projects = listProjects().filter((x) => x.name !== p.name);
  projects.push(p);
  projects.sort((a, b) => a.name.localeCompare(b.name));
  saveAll(projects);
  return projects;
}

export function removeProject(name: string): Project[] {
  const projects = listProjects().filter((x) => x.name !== name);
  saveAll(projects);
  return projects;
}

export function getSession(): Session {
  try {
    return JSON.parse(readFileSync(file("session.json"), "utf8"));
  } catch {
    return {};
  }
}

export function setSession(s: Session): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file("session.json"), JSON.stringify(s, null, 2));
}

export function getPanes(): PanesState {
  try {
    const parsed = JSON.parse(readFileSync(file("panes.json"), "utf8"));
    return Array.isArray(parsed.panes) ? parsed : { panes: [] };
  } catch {
    return { panes: [] };
  }
}

export function setPanes(state: PanesState): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file("panes.json"), JSON.stringify(state, null, 2));
}

/** Native build fingerprint (from @expo/fingerprint) recorded per project dir at
 * last Devloop build, so we can detect when the installed binary is stale. */
export function getProjectFingerprint(cwd: string): string | undefined {
  try {
    const map = JSON.parse(readFileSync(file("fingerprints.json"), "utf8")) as Record<string, string>;
    return map[cwd];
  } catch {
    return undefined;
  }
}

export function setProjectFingerprint(cwd: string, hash: string): void {
  mkdirSync(dir(), { recursive: true });
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(readFileSync(file("fingerprints.json"), "utf8")) as Record<string, string>;
  } catch {
    /* first write */
  }
  map[cwd] = hash;
  writeFileSync(file("fingerprints.json"), JSON.stringify(map, null, 2));
}

/** Paths of unpacked extensions to reload on launch (store extensions persist themselves). */
export function getUnpackedExtensions(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file("unpacked-extensions.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setUnpackedExtensions(paths: string[]): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file("unpacked-extensions.json"), JSON.stringify([...new Set(paths)], null, 2));
}

/** Extension ids the user toggled off — kept installed but not loaded. */
export function getDisabledExtensions(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file("disabled-extensions.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setDisabledExtensions(ids: string[]): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file("disabled-extensions.json"), JSON.stringify([...new Set(ids)], null, 2));
}
