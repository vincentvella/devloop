/** Timeline renderer — renders the unified buffer, live, with filter + error highlight. */

interface Entry {
  seq: number;
  ts: number;
  source: "server" | "browser" | "repro";
  stream: string;
  line: string;
  target?: string;
}

interface Pane {
  id: string;
  url: string;
  active: boolean;
}

interface Step {
  kind: string;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
}

interface ReproResult {
  stepCount: number;
  errorCount: number;
  stoppedAtStep: number | null;
  steps: { index: number; action: { kind: string }; error?: string }[];
  errors: { source: string; stream: string; line: string }[];
}

interface Session {
  cmd?: string;
  cwd?: string;
  url?: string;
  steps?: Step[];
}

interface DevStatus {
  running: boolean;
  cmd?: string;
  cwd?: string;
}

interface Project {
  name: string;
  cwd: string;
  cmd?: string;
  url?: string;
  steps?: Step[];
}

declare global {
  interface Window {
    devloop: {
      getLogs: (opts?: { limit?: number }) => Promise<Entry[]>;
      clear: () => Promise<boolean>;
      navigate: (url: string) => Promise<{ url: string; status: number | null }>;
      devStart: (opts: { cmd?: string; cwd?: string }) => Promise<DevStatus>;
      devStop: () => Promise<boolean>;
      devStatus: () => Promise<DevStatus>;
      pickFolder: () => Promise<string | null>;
      projects: () => Promise<Project[]>;
      projectAdd: (p: Project) => Promise<Project[]>;
      openProject: (name: string) => Promise<unknown>;
      panes: () => Promise<Pane[]>;
      paneNew: (url?: string) => Promise<Pane>;
      paneSelect: (id: string) => Promise<Pane>;
      paneClose: (id: string) => Promise<boolean>;
      onPanesChanged: (cb: () => void) => () => void;
      repro: (args: unknown) => Promise<ReproResult>;
      session: () => Promise<Session>;
      sessionSave: (s: Session) => Promise<void>;
      onPush: (cb: (e: Entry) => void) => () => void;
    };
  }
}

const list = document.getElementById("list")!;
const filter = document.getElementById("filter") as HTMLInputElement;
const errOnly = document.getElementById("errOnly") as HTMLInputElement;
const clearBtn = document.getElementById("clear")!;
const urlInput = document.getElementById("url") as HTMLInputElement;
const goBtn = document.getElementById("go")!;
const devCmd = document.getElementById("devcmd") as HTMLInputElement;
const devCwd = document.getElementById("devcwd") as HTMLInputElement;
const devBtn = document.getElementById("devbtn")!;
const devStatusEl = document.getElementById("devstatus")!;
const browseBtn = document.getElementById("browse")!;
const projectSel = document.getElementById("project") as HTMLSelectElement;
const openBtn = document.getElementById("open")!;
const pname = document.getElementById("pname") as HTMLInputElement;
const saveBtn = document.getElementById("save")!;
const panesBar = document.getElementById("panes")!;
const stepsEl = document.getElementById("steps")!;
const addStepBtn = document.getElementById("addstep")!;
const runReproBtn = document.getElementById("runrepro")!;
const reproStatus = document.getElementById("reprostatus")!;

let entries: Entry[] = [];
let filterTarget: string | null = null; // null = all panes
let projectsCache: Project[] = [];

function isErr(e: Entry): boolean {
  return (
    e.stream === "pageerror" ||
    e.stream === "network" ||
    (e.stream === "console" && /\[error\]/.test(e.line)) ||
    (e.source === "server" && /error|exception|traceback|unhandled/i.test(e.line)) ||
    (e.source === "repro" && e.line.includes("✗"))
  );
}

/** Accept a bare port ("3000" → http://localhost:3000) or any http(s) URL or host. */
function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^\d+$/.test(v)) return `http://localhost:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  return `http://${v}`;
}

function render(): void {
  const q = filter.value.toLowerCase();
  const onlyErr = errOnly.checked;
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    if (q && !e.line.toLowerCase().includes(q)) continue;
    if (onlyErr && !isErr(e)) continue;
    // Per-pane filter: keep server events always, browser events only for the selected pane.
    if (filterTarget && e.source === "browser" && e.target !== filterTarget) continue;
    const row = document.createElement("div");
    row.className = `row ${e.source}${isErr(e) ? " err" : ""}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${e.source}:${e.stream}`;
    row.append(tag);
    if (e.target) {
      const tgt = document.createElement("span");
      tgt.className = "tgt";
      tgt.textContent = e.target;
      row.append(tgt);
    }
    row.append(document.createTextNode(e.line));
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
  list.scrollTop = list.scrollHeight;
}

async function renderPanes(): Promise<void> {
  const panes = await window.devloop.panes();
  const frag = document.createDocumentFragment();

  const all = document.createElement("span");
  all.className = `pane${filterTarget === null ? " active" : ""}`;
  all.textContent = "all";
  all.style.paddingRight = "10px";
  all.addEventListener("click", () => {
    filterTarget = null;
    void renderPanes();
    render();
  });
  frag.appendChild(all);

  for (const p of panes) {
    const el = document.createElement("span");
    el.className = `pane${p.active ? " active" : ""}`;
    const label = document.createElement("span");
    label.textContent = p.id;
    label.addEventListener("click", async () => {
      await window.devloop.paneSelect(p.id);
      filterTarget = p.id;
      render();
    });
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await window.devloop.paneClose(p.id);
      if (filterTarget === p.id) filterTarget = null;
    });
    el.append(label, x);
    frag.appendChild(el);
  }

  const add = document.createElement("span");
  add.className = "pane";
  add.textContent = "+ pane";
  add.addEventListener("click", () => void window.devloop.paneNew());
  frag.appendChild(add);

  panesBar.replaceChildren(frag);
}

async function refreshDevStatus(): Promise<void> {
  const s = await window.devloop.devStatus();
  devStatusEl.textContent = s.running ? `dev: ${s.cmd}` : "dev: stopped";
  (devBtn as HTMLButtonElement).textContent = s.running ? "dev stop" : "dev start";
}

async function refreshProjects(selected?: string): Promise<void> {
  projectsCache = await window.devloop.projects();
  projectSel.replaceChildren(new Option("— project —", ""));
  for (const p of projectsCache) projectSel.add(new Option(p.name, p.name));
  if (selected) projectSel.value = selected;
}

/** Fill the form (cmd/cwd/url/steps) from a saved project without starting it. */
function fillFromProject(name: string): void {
  const p = projectsCache.find((x) => x.name === name);
  if (!p) return;
  devCwd.value = p.cwd;
  devCmd.value = p.cmd ?? "";
  urlInput.value = p.url ?? "";
  pname.value = p.name;
  loadSteps(p.steps);
}

async function navigate(): Promise<void> {
  const url = normalizeUrl(urlInput.value);
  if (url) {
    await window.devloop.navigate(url);
    saveSession();
  }
}

function saveSession(): void {
  void window.devloop.sessionSave({
    cmd: devCmd.value.trim(),
    cwd: devCwd.value.trim(),
    url: urlInput.value.trim(),
    steps: collectActions() as Step[],
  });
}

// --- repro builder ---
function addStep(step?: Step): void {
  const row = document.createElement("div");
  row.className = "step";
  const sel = document.createElement("select");
  for (const k of ["navigate", "click", "type", "eval", "none"]) sel.add(new Option(k, k));
  sel.value = step?.kind ?? "navigate";
  const a1 = document.createElement("input");
  const a2 = document.createElement("input");
  a1.value = step?.url ?? step?.selector ?? step?.expression ?? "";
  a2.value = step?.text ?? "";
  const sync = () => {
    a1.placeholder = { navigate: "url", click: "selector", type: "selector", eval: "expression", none: "" }[sel.value]!;
    a1.style.display = sel.value === "none" ? "none" : "";
    a2.style.display = sel.value === "type" ? "" : "none";
    a2.placeholder = "text";
  };
  sel.addEventListener("change", sync);
  sync();
  const del = document.createElement("span");
  del.className = "del";
  del.textContent = "×";
  del.addEventListener("click", () => row.remove());
  row.append(sel, a1, a2, del);
  stepsEl.appendChild(row);
}

function loadSteps(steps?: Step[]): void {
  stepsEl.replaceChildren();
  if (steps && steps.length) steps.forEach((s) => addStep(s));
  else addStep();
}

function collectActions(): Record<string, string>[] {
  return [...stepsEl.querySelectorAll(".step")].map((row) => {
    const kind = (row.querySelector("select") as HTMLSelectElement).value;
    const [a1, a2] = row.querySelectorAll("input");
    const v1 = (a1 as HTMLInputElement).value.trim();
    const v2 = (a2 as HTMLInputElement).value.trim();
    if (kind === "navigate") return { kind, url: v1 };
    if (kind === "click") return { kind, selector: v1 };
    if (kind === "type") return { kind, selector: v1, text: v2 };
    if (kind === "eval") return { kind, expression: v1 };
    return { kind };
  });
}

function reproRow(stream: string, line: string): void {
  entries.push({ seq: -1, ts: Date.now(), source: "repro", stream, line });
}

async function runRepro(): Promise<void> {
  const actions = collectActions();
  if (!actions.length) {
    reproStatus.textContent = "add a step first";
    return;
  }
  reproStatus.textContent = "running…";
  const r = await window.devloop.repro({ actions, clear: false });
  const stopped = r.stoppedAtStep === null ? "" : ` · stopped@${r.stoppedAtStep}`;
  reproStatus.textContent = `${r.stepCount} steps · ${r.errorCount} errors${stopped}`;

  // Render the result inline in the timeline.
  reproRow("summary", `▶ repro · ${r.stepCount} steps · ${r.errorCount} errors${stopped}`);
  for (const s of r.steps) reproRow("step", `   ${s.index}. ${s.action.kind} ${s.error ? "✗ " + s.error : "✓"}`);
  for (const e of r.errors) reproRow("error", `   ✗ [${e.source}:${e.stream}] ${e.line}`);
  render();
  saveSession();
}

async function init(): Promise<void> {
  entries = await window.devloop.getLogs({ limit: 1000 });
  render();
  window.devloop.onPush((e) => {
    entries.push(e);
    render();
  });
  filter.addEventListener("input", render);
  errOnly.addEventListener("change", render);
  clearBtn.addEventListener("click", async () => {
    await window.devloop.clear();
    entries = [];
    render();
  });

  goBtn.addEventListener("click", navigate);
  urlInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void navigate();
  });

  devBtn.addEventListener("click", async () => {
    const s = await window.devloop.devStatus();
    if (s.running) {
      await window.devloop.devStop();
    } else {
      await window.devloop.devStart({ cmd: devCmd.value.trim() || undefined, cwd: devCwd.value.trim() || undefined });
      saveSession();
    }
    await refreshDevStatus();
  });

  browseBtn.addEventListener("click", async () => {
    const dir = await window.devloop.pickFolder();
    if (!dir) return;
    devCwd.value = dir;
    if (!pname.value.trim()) pname.value = dir.split("/").filter(Boolean).pop() ?? ""; // prefill save-as name
  });

  // Project registry: pick fills the form; open runs it; save snapshots the form (incl. steps).
  projectSel.addEventListener("change", () => {
    if (projectSel.value) fillFromProject(projectSel.value);
  });
  openBtn.addEventListener("click", async () => {
    if (!projectSel.value) return;
    fillFromProject(projectSel.value);
    await window.devloop.openProject(projectSel.value);
    saveSession();
    await refreshDevStatus();
  });
  saveBtn.addEventListener("click", async () => {
    const name = pname.value.trim();
    const cwd = devCwd.value.trim();
    if (!name || !cwd) return;
    await window.devloop.projectAdd({
      name,
      cwd,
      cmd: devCmd.value.trim() || undefined,
      url: urlInput.value.trim() || undefined,
      steps: collectActions() as Step[],
    });
    await refreshProjects(name);
  });

  window.devloop.onPanesChanged(() => void renderPanes());

  addStepBtn.addEventListener("click", () => addStep());
  runReproBtn.addEventListener("click", runRepro);

  // Restore last-used setup (dev cmd/cwd, url, repro steps).
  const session = await window.devloop.session();
  devCmd.value = session.cmd ?? "";
  devCwd.value = session.cwd ?? "";
  urlInput.value = session.url ?? "";
  loadSteps(session.steps);

  await refreshDevStatus();
  await refreshProjects();
  await renderPanes();
}

void init();
