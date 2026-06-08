/**
 * Project registry — a small persisted list of projects so you pick a saved
 * project by name instead of retyping cmd/cwd every time. Backed by a JSON file
 * (default ~/.devloop/projects.json; override with DEVLOOP_HOME). Pure Node, no
 * Electron — shared by the stdio server and the cockpit.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Project {
  name: string;
  cwd: string;
  /** Dev command; if omitted, auto-detected from package.json at start time. */
  cmd?: string;
  /** Default URL to open in the browser pane. */
  url?: string;
}

const DIR = process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop");
const FILE = join(DIR, "projects.json");

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
