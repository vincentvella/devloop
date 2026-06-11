import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Play,
  Square,
  Power,
  RotateCw,
  RefreshCw,
  Camera,
  Settings,
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
  X,
  Plus,
  FolderOpen,
  ArrowDown,
  Save,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import type { Entry, Pane, Project, Step } from "./global";

const dl = () => window.devloop;

// Accessible icon button with a Radix tooltip.
function IconBtn({ tip, onClick, children, disabled }: { tip: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="icon" aria-label={tip} onClick={onClick} disabled={disabled}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={4}>
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// --- helpers ---------------------------------------------------------------
function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (/^\d+$/.test(v)) return `http://localhost:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  return `http://${v}`;
}
function isErr(e: Entry): boolean {
  return (
    e.stream === "pageerror" ||
    e.stream === "network" ||
    (e.stream === "console" && /\[error\]/.test(e.line)) ||
    (e.source === "server" && /error|exception|traceback|unhandled/i.test(e.line)) ||
    (e.source === "repro" && e.line.includes("✗"))
  );
}
const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const CHIPS: { key: string; label: string; test: (e: Entry) => boolean }[] = [
  { key: "server", label: "server", test: (e) => e.source === "server" },
  { key: "console", label: "console", test: (e) => e.stream === "console" },
  { key: "network", label: "network", test: (e) => e.stream === "network" },
  { key: "errors", label: "errors", test: isErr },
  { key: "repro", label: "repro", test: (e) => e.source === "repro" },
];

let reproUid = -1; // unique negative keys for client-side repro rows

// --- log row (own expand state) -------------------------------------------
function LogRow({ e, onZoom }: { e: Entry; onZoom: (img: string) => void }) {
  const [open, setOpen] = useState(false);
  const long = e.line.length > 220 || (e.line.match(/\n/g)?.length ?? 0) > 2;
  const cls = ["logrow", e.source];
  if (isErr(e)) cls.push("err");
  else if (e.stream === "console" && e.line.includes("[warning]")) cls.push("warn");
  return (
    <div className={cls.join(" ")}>
      <span className="ts">{fmtTime(e.ts)}</span>
      <span className="tag">
        {e.source}:{e.stream}
      </span>
      {e.target && <span className="tgt">{e.target}</span>}
      {e.stream === "screenshot" && e.detail?.image ? (
        <img className="shot" src={e.detail.image} onClick={() => onZoom(e.detail!.image!)} />
      ) : (
        <span
          className={`msg${long && !open ? " clamp" : ""}`}
          onClick={long ? () => setOpen((v) => !v) : undefined}
          title={long ? (open ? "click to collapse" : "click to expand") : undefined}
        >
          {e.line}
        </span>
      )}
    </div>
  );
}

// --- app -------------------------------------------------------------------
function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(460);
  const [dragging, setDragging] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selProject, setSelProject] = useState("");
  const [devCmd, setDevCmd] = useState("");
  const [devCwd, setDevCwd] = useState("");
  const [url, setUrl] = useState("");
  const [steps, setSteps] = useState<Step[]>([{ kind: "navigate" }]);
  const [reproStatus, setReproStatus] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [editingPane, setEditingPane] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [panelTab, setPanelTab] = useState<"logs" | "repro">("logs");

  const paneAreaRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const active = panes.find((p) => p.active);
  const dev = active?.dev;
  const devRunning = !!dev?.running;
  const devFailed = !devRunning && typeof dev?.exitCode === "number" && dev.exitCode !== 0;
  // When the active pane is popped into its own window, its embedded view is gone —
  // let the timeline fill the freed space.
  const fillTimeline = !!active?.popped && !sidebarHidden;

  const refreshPanes = useCallback(async () => {
    const ps = await dl().panes();
    setPanes(ps);
    const a = ps.find((p) => p.active);
    setDevCmd(a?.dev?.cmd ?? "");
    setDevCwd(a?.dev?.cwd ?? "");
  }, []);
  const refreshProjects = useCallback(async () => setProjects(await dl().projects()), []);

  // Save the active pane's dev cmd/cwd (auto-applied on blur / folder pick).
  const applyDevConfig = useCallback(
    async (cmd: string, cwd: string) => {
      await dl().setDevConfig({ cmd: cmd.trim() || undefined, cwd: cwd.trim() || undefined });
      await refreshPanes();
    },
    [refreshPanes],
  );

  useEffect(() => {
    void (async () => {
      setEntries((await dl().getLogs({ limit: 1000 })).map((e) => ({ ...e })));
      const s = await dl().session();
      if (s.steps?.length) setSteps(s.steps);
      if (s.project) setSelProject(s.project);
      await refreshPanes();
      await refreshProjects();
      setLoaded(true);
    })();
    const offPush = dl().onPush((e) => setEntries((cur) => [...cur.slice(-1999), e]));
    const offPanes = dl().onPanesChanged(() => void refreshPanes());
    return () => {
      offPush();
      offPanes();
    };
  }, [refreshPanes, refreshProjects]);

  // keep the embedded view aligned with the pane area on layout changes.
  useEffect(() => {
    const el = paneAreaRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void dl().setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [sidebarHidden, settingsOpen, sidebarWidth, panes.length, fillTimeline]);

  // smart auto-scroll: only stick to bottom if already near it.
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [entries, atBottom]);

  useEffect(() => {
    void dl().overlay(lightbox !== null);
  }, [lightbox]);

  const saveSession = useCallback(() => {
    void dl().sessionSave({ cmd: devCmd.trim(), cwd: devCwd.trim(), steps, project: selProject });
  }, [devCmd, devCwd, steps, selProject]);

  // Address bar follows the active pane's current URL (link clicks / SPA routes update it).
  useEffect(() => {
    setUrl(active?.url && active.url !== "about:blank" ? active.url : "");
  }, [active?.url]);

  // Persist the form (incl. project + save-as) on any change, debounced.
  // Gated on `loaded` so the initial blank render can't overwrite the saved session.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(saveSession, 300);
    return () => clearTimeout(t);
  }, [saveSession, loaded]);

  const labelActive = useCallback(
    async (name: string) => {
      const a = (await dl().panes()).find((p) => p.active);
      if (a) await dl().paneSetLabel(a.id, name);
      await refreshPanes();
    },
    [refreshPanes],
  );

  const navigate = useCallback(async () => {
    const u = normalizeUrl(url);
    if (u) {
      await dl().navigate(u);
      saveSession();
    }
  }, [url, saveSession]);

  const onPlay = useCallback(async () => {
    if (devRunning) await dl().devStop();
    else if (!dev?.cmd && !dev?.cwd) {
      setSettingsOpen(true);
      return;
    } else {
      try {
        const st = await dl().devStart({});
        if (st.name) await labelActive(st.name);
      } catch (e) {
        setReproStatus(`dev: ${(e as Error)?.message?.split(": ").pop() ?? "start failed"}`);
      }
    }
    await refreshPanes();
  }, [devRunning, dev, labelActive, refreshPanes]);

  const runRepro = useCallback(
    async (actions: Step[]) => {
      if (!actions.length) return setReproStatus("add a step first");
      setReproStatus("running…");
      const r = await dl().repro({ actions, clear: false });
      const stopped = r.stoppedAtStep === null ? "" : ` · stopped@${r.stoppedAtStep}`;
      setReproStatus(`${r.stepCount} steps · ${r.errorCount} errors${stopped}`);
      const now = Date.now();
      const rows: Entry[] = [{ seq: reproUid--, ts: now, source: "repro", stream: "summary", line: `▶ repro · ${r.stepCount} steps · ${r.errorCount} errors${stopped}` }];
      for (const s of r.steps) rows.push({ seq: reproUid--, ts: now, source: "repro", stream: "step", line: `   ${s.index}. ${s.action.kind} ${s.error ? "✗ " + s.error : "✓"}` });
      for (const e of r.errors) rows.push({ seq: reproUid--, ts: now, source: "repro", stream: "error", line: `   ✗ [${e.source}:${e.stream}] ${e.line}` });
      setEntries((cur) => [...cur, ...rows]);
      setPanelTab("logs"); // surface the run's output in the timeline
      saveSession();
    },
    [saveSession],
  );
  useEffect(() => {
    (window as unknown as { __devloopTest?: unknown }).__devloopTest = { runRepro };
  }, [runRepro]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.metaKey) return;
      const k = ev.key.toLowerCase();
      if (k === "l") {
        ev.preventDefault();
        urlRef.current?.focus();
        urlRef.current?.select();
      } else if (k === "r") {
        ev.preventDefault();
        void dl().reload(ev.shiftKey); // ⌘R reload page, ⌘⇧R hard reload (intercept Electron's reload)
      } else if (k === "k") {
        ev.preventDefault();
        void dl().clear();
        setEntries([]);
      } else if (k === "b") {
        ev.preventDefault();
        setSidebarHidden((v) => !v);
      } else if (k === ",") {
        ev.preventDefault();
        setSettingsOpen((v) => !v);
      } else if (/^[1-9]$/.test(k)) {
        const p = panes[Number(k) - 1];
        if (p) {
          ev.preventDefault();
          void dl().paneSelect(p.id).then(refreshPanes);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panes, refreshPanes]);

  // draggable sidebar divider
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: MouseEvent) => setSidebarWidth(Math.min(800, Math.max(280, window.innerWidth - ev.clientX)));
    const up = () => {
      setDragging(false);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, []);

  const fillFromProject = (name: string) => {
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    setDevCwd(p.cwd);
    setDevCmd(p.cmd ?? "");
    setUrl(p.url ?? "");
    setSteps(p.steps?.length ? p.steps : [{ kind: "navigate" }]);
  };

  // Open a saved project (fill the form, then dev_start + navigate on the active pane).
  const openProject = useCallback(
    async (name: string) => {
      if (!name) return;
      setSelProject(name);
      fillFromProject(name);
      const res = await dl().openProject(name);
      await labelActive(res.name);
      await refreshPanes();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, labelActive, refreshPanes],
  );

  // Save the active pane as a project (named by its tab label / folder; rename on the tab).
  const saveProject = useCallback(async () => {
    const a = (await dl().panes()).find((p) => p.active);
    const name = a?.label || devCwd.split("/").filter(Boolean).pop();
    if (!name || !devCwd.trim()) return;
    await dl().projectAdd({ name, cwd: devCwd.trim(), cmd: devCmd.trim() || undefined, url: url.trim() || undefined, steps });
    await refreshProjects();
    setSelProject(name);
  }, [devCwd, devCmd, url, steps, refreshProjects]);

  const toggleChip = (key: string) =>
    setChips((cur) => {
      const next = new Set(cur);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const shown = entries.filter((e) => {
    if (filter && !e.line.toLowerCase().includes(filter.toLowerCase())) return false;
    if (chips.size && !CHIPS.some((c) => chips.has(c.key) && c.test(e))) return false;
    // Always scope the timeline to the active pane (untargeted entries, e.g. repro, still show).
    if (active && e.target && e.target !== active.id) return false;
    return true;
  });

  return (
    <Tooltip.Provider delayDuration={250}>
      <div className="toolbar">
        <div className="bar">
          <div className="tabs">
            {panes.map((p) => (
              <span
                key={p.id}
                className={`tab${p.active ? " active" : ""}${p.dev?.running ? " run" : ""}${
                  !p.dev?.running && typeof p.dev?.exitCode === "number" && p.dev.exitCode !== 0 ? " fail" : ""
                }`}
                onClick={async () => {
                  await dl().paneSelect(p.id);
                  await refreshPanes();
                }}
                onDoubleClick={() => {
                  setEditingPane(p.id);
                  setEditLabel(p.label ?? "");
                }}
                title="double-click to rename"
              >
                <span className="dot" />
                {editingPane === p.id ? (
                  <input
                    className="edit"
                    autoFocus
                    value={editLabel}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onBlur={async () => {
                      if (editLabel.trim()) await dl().paneSetLabel(p.id, editLabel.trim());
                      setEditingPane(null);
                      await refreshPanes();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingPane(null);
                    }}
                  />
                ) : (
                  <span className="name">{(p.label ?? p.id) + (p.popped ? " ⤢" : "")}</span>
                )}
                <span
                  className="x"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void dl().paneClose(p.id).then(refreshPanes);
                  }}
                >
                  <X size={13} />
                </span>
              </span>
            ))}
            <span className="tab add" onClick={() => void dl().paneNew().then(refreshPanes)}>
              <Plus size={13} /> pane
            </span>
          </div>

          <div className="spacer" />

          <IconBtn tip="settings (⌘,)" onClick={() => setSettingsOpen((v) => !v)}>
            <Settings size={15} />
          </IconBtn>
        </div>

        {settingsOpen && (
          <div className="settings">
            <div className="row">
              <span className="field-label">project</span>
              <select value={selProject} onChange={(e) => void openProject(e.target.value)}>
                <option value="">— open a saved project —</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="labeled" title="save the active pane as a project (rename on its tab)" onClick={() => void saveProject()}>
                <Save size={13} /> save
              </button>
            </div>
            <div className="row">
              <span className="field-label">dev</span>
              <input
                placeholder="cmd (blank = auto-detect)"
                value={devCmd}
                onChange={(e) => setDevCmd(e.target.value)}
                onBlur={() => void applyDevConfig(devCmd, devCwd)}
              />
              <button
                title="browse for project folder"
                onClick={async () => {
                  const dir = await dl().pickFolder();
                  if (!dir) return;
                  setDevCwd(dir);
                  await applyDevConfig(devCmd, dir);
                }}
              >
                <FolderOpen size={14} />
              </button>
              <input
                placeholder="project folder (cwd)"
                value={devCwd}
                onChange={(e) => setDevCwd(e.target.value)}
                onBlur={() => void applyDevConfig(devCmd, devCwd)}
              />
            </div>
          </div>
        )}
      </div>

      {!active?.popped && (
      <div className="browser-bar">
        <IconBtn tip="back" disabled={!active?.nav?.canBack} onClick={() => void dl().back().then(refreshPanes)}>
          <ArrowLeft size={15} />
        </IconBtn>
        <IconBtn tip="forward" disabled={!active?.nav?.canForward} onClick={() => void dl().forward().then(refreshPanes)}>
          <ArrowRight size={15} />
        </IconBtn>
        <IconBtn tip="reload page (⌘R)" onClick={() => void dl().reload(false)}>
          <RotateCw size={15} />
        </IconBtn>
        <IconBtn tip="hard reload — ignore cache (⌘⇧R)" onClick={() => void dl().reload(true)}>
          <RefreshCw size={15} />
        </IconBtn>
        <input
          ref={urlRef}
          className="address"
          placeholder="3000  or  http://localhost:3000  —  ↵ to open"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void navigate()}
        />
        <IconBtn tip="screenshot → timeline" onClick={() => void dl().screenshot()}>
          <Camera size={15} />
        </IconBtn>
        <IconBtn
          tip="pop active pane into its own window"
          onClick={async () => {
            if (active && !active.popped) await dl().panePop(active.id);
            await refreshPanes();
          }}
        >
          <ExternalLink size={15} />
        </IconBtn>
      </div>
      )}

      <div className="body">
        <div className="pane-area" ref={paneAreaRef} style={fillTimeline ? { display: "none" } : undefined}>
          {panes.length === 0 && <div className="hint">no pane — open a project or add a pane (+)</div>}
        </div>

        {!sidebarHidden && !fillTimeline && <div className={`divider${dragging ? " drag" : ""}`} onMouseDown={startDrag} />}

        <div
          className={`sidebar${sidebarHidden ? " hidden" : ""}`}
          style={sidebarHidden ? { width: 0 } : fillTimeline ? { flex: 1 } : { width: sidebarWidth }}
        >
          <div className="panel-head">
            <div className="segmented">
              <button className={`seg${panelTab === "logs" ? " on" : ""}`} onClick={() => setPanelTab("logs")}>
                logs
              </button>
              <button className={`seg${panelTab === "repro" ? " on" : ""}`} onClick={() => setPanelTab("repro")}>
                repro
              </button>
            </div>
            <span className="spacer" />
            {devFailed && <span className="dev-status fail">✗ exited {dev?.exitCode}</span>}
            <IconBtn tip="start / stop dev server" onClick={() => void onPlay()}>
              {devRunning ? <Square size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            </IconBtn>
            <IconBtn tip="restart dev server" onClick={() => void dl().devRestart().then(refreshPanes)}>
              <Power size={15} />
            </IconBtn>
            <button className="collapse-btn" title="collapse timeline (⌘B)" onClick={() => setSidebarHidden(true)}>
              <PanelRightClose size={15} />
            </button>
          </div>

          {panelTab === "repro" ? (
            <>
              <div className="repro-head">
                <button className="labeled" onClick={() => setSteps((s) => [...s, { kind: "navigate" }])}>
                  <Plus size={13} /> step
                </button>
                <button className="labeled" onClick={() => void runRepro(steps)}>
                  <Play size={13} /> run
                </button>
                <span className="chip" style={{ border: "none", opacity: 0.7 }}>
                  {reproStatus}
                </span>
              </div>
              <div className="steps">
                {steps.map((s, i) => (
                  <ReproStepRow
                    key={i}
                    step={s}
                    onChange={(ns) => setSteps((cur) => cur.map((x, j) => (j === i ? ns : x)))}
                    onDelete={() => setSteps((cur) => cur.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="filterbar">
                <input placeholder="filter (substring)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <div className="chips">
                  {CHIPS.map((c) => (
                    <span key={c.key} className={`fchip${chips.has(c.key) ? " on" : ""}`} onClick={() => toggleChip(c.key)}>
                      {c.label}
                    </span>
                  ))}
                </div>
                <button
                  onClick={async () => {
                    await dl().clear();
                    setEntries([]);
                  }}
                >
                  clear
                </button>
              </div>

              <div className="list-wrap">
                <div
                  className="list"
                  id="list"
                  ref={listRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
                  }}
                >
                  {shown.map((e, i) => (
                    <LogRow key={`${e.seq}:${i}`} e={e} onZoom={setLightbox} />
                  ))}
                </div>
                {!atBottom && (
                  <button
                    className="pill"
                    onClick={() => {
                      const el = listRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                      setAtBottom(true);
                    }}
                  >
                    <ArrowDown size={13} /> latest
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {sidebarHidden && (
          <div className="edge">
            <div className="handle" title="show timeline (⌘B)" onClick={() => setSidebarHidden(false)}>
              <PanelRightOpen size={14} />
            </div>
          </div>
        )}
      </div>

      <Dialog.Root open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="lightbox-overlay" />
          <Dialog.Content className="lightbox-content" onClick={() => setLightbox(null)}>
            <Dialog.Title className="sr-only">Screenshot</Dialog.Title>
            {lightbox && <img src={lightbox} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Tooltip.Provider>
  );
}

function ReproStepRow({ step, onChange, onDelete }: { step: Step; onChange: (s: Step) => void; onDelete: () => void }) {
  const k = step.kind;
  const a1 = step.url ?? step.selector ?? step.expression ?? "";
  const set1 = (v: string) => {
    if (k === "navigate") onChange({ kind: k, url: v });
    else if (k === "click") onChange({ kind: k, selector: v });
    else if (k === "type") onChange({ kind: k, selector: v, text: step.text });
    else if (k === "eval") onChange({ kind: k, expression: v });
    else onChange({ kind: k });
  };
  const ph = { navigate: "url", click: "selector", type: "selector", eval: "expression", none: "" }[k] ?? "";
  return (
    <div className="step">
      <select value={k} onChange={(e) => onChange({ kind: e.target.value })}>
        {["navigate", "click", "type", "eval", "none"].map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      {k !== "none" && <input placeholder={ph} value={a1} onChange={(e) => set1(e.target.value)} />}
      {k === "type" && <input placeholder="text" value={step.text ?? ""} onChange={(e) => onChange({ ...step, text: e.target.value })} />}
      <span className="del" onClick={onDelete}>
        <X size={13} />
      </span>
    </div>
  );
}

// A popped-out pane loads this same bundle with ?pop=<id> — render just its browser bar + view.
function PopApp({ paneId }: { paneId: string }) {
  const [pane, setPane] = useState<Pane | null>(null);
  const [url, setUrl] = useState("");
  const paneAreaRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setPane((await dl().panes()).find((p) => p.id === paneId) ?? null);
  }, [paneId]);

  useEffect(() => {
    void refresh();
    return dl().onPanesChanged(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    setUrl(pane?.url && pane.url !== "about:blank" ? pane.url : "");
  }, [pane?.url]);

  useEffect(() => {
    const el = paneAreaRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void dl().setBoundsFor(paneId, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [paneId]);

  // Intercept ⌘R so it reloads the PAGE, not the pop window's chrome.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.metaKey) return;
      if (ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        void dl().reloadFor(paneId, ev.shiftKey);
      } else if (ev.key.toLowerCase() === "l") {
        ev.preventDefault();
        urlRef.current?.focus();
        urlRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneId]);

  const navigate = () => {
    const u = normalizeUrl(url);
    if (u) void dl().navigateFor(paneId, u);
  };

  return (
    <Tooltip.Provider delayDuration={250}>
      <div className="browser-bar">
        <IconBtn tip="back" disabled={!pane?.nav?.canBack} onClick={() => void dl().backFor(paneId).then(refresh)}>
          <ArrowLeft size={15} />
        </IconBtn>
        <IconBtn tip="forward" disabled={!pane?.nav?.canForward} onClick={() => void dl().forwardFor(paneId).then(refresh)}>
          <ArrowRight size={15} />
        </IconBtn>
        <IconBtn tip="reload page (⌘R)" onClick={() => void dl().reloadFor(paneId, false)}>
          <RotateCw size={15} />
        </IconBtn>
        <IconBtn tip="hard reload — ignore cache (⌘⇧R)" onClick={() => void dl().reloadFor(paneId, true)}>
          <RefreshCw size={15} />
        </IconBtn>
        <input
          ref={urlRef}
          className="address"
          placeholder="3000  or  http://localhost:3000  —  ↵ to open"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate()}
        />
        <IconBtn tip="screenshot → timeline" onClick={() => void dl().screenshotFor(paneId)}>
          <Camera size={15} />
        </IconBtn>
      </div>
      <div className="pane-area" ref={paneAreaRef} style={{ flex: 1 }} />
    </Tooltip.Provider>
  );
}

const popId = new URLSearchParams(location.search).get("pop");
createRoot(document.getElementById("root")!).render(popId ? <PopApp paneId={popId} /> : <App />);
