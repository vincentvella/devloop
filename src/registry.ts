/**
 * Project registry — a small persisted list of projects so you pick a saved
 * project by name instead of retyping cmd/cwd every time. Backed by a JSON file
 * (default ~/.devloop/projects.json; override with DEVLOOP_HOME). Pure Node, no
 * Electron — shared by the stdio server and the cockpit.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

const DIR = process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop");
const FILE = join(DIR, "projects.json");
const SESSION_FILE = join(DIR, "session.json");
const PANES_FILE = join(DIR, "panes.json");

export function listProjects(): Project[] {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // no file yet
  }
}

export function getProject(name: string): Project | undefined {
  return listProjects().find((p) => p.name === name);
}

function saveAll(projects: Project[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(projects, null, 2));
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
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function setSession(s: Session): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

export function getPanes(): PanesState {
  try {
    const parsed = JSON.parse(readFileSync(PANES_FILE, "utf8"));
    return Array.isArray(parsed.panes) ? parsed : { panes: [] };
  } catch {
    return { panes: [] };
  }
}

export function setPanes(state: PanesState): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PANES_FILE, JSON.stringify(state, null, 2));
}

const EXT_FILE = join(DIR, "unpacked-extensions.json");

/** Paths of unpacked extensions to reload on launch (store extensions persist themselves). */
export function getUnpackedExtensions(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(EXT_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setUnpackedExtensions(paths: string[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(EXT_FILE, JSON.stringify([...new Set(paths)], null, 2));
}
