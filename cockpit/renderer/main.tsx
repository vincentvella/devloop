import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Entry, Pane, Project, Step } from "./global";

const dl = () => window.devloop;

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

// --- app -------------------------------------------------------------------
function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState("");
  const [errOnly, setErrOnly] = useState(false);
  const [filterTarget, setFilterTarget] = useState<string | null>(null); // null = all panes
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selProject, setSelProject] = useState("");
  const [pname, setPname] = useState("");
  const [devCmd, setDevCmd] = useState("");
  const [devCwd, setDevCwd] = useState("");
  const [url, setUrl] = useState("");
  const [steps, setSteps] = useState<Step[]>([{ kind: "navigate" }]);
  const [reproStatus, setReproStatus] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

  const paneAreaRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const active = panes.find((p) => p.active);
  const dev = active?.dev;
  const devRunning = !!dev?.running;
  const devFailed = !devRunning && typeof dev?.exitCode === "number" && dev.exitCode !== 0;

  const refreshPanes = useCallback(async () => {
    const ps = await dl().panes();
    setPanes(ps);
    const a = ps.find((p) => p.active);
    setDevCmd(a?.dev?.cmd ?? "");
    setDevCwd(a?.dev?.cwd ?? "");
  }, []);
  const refreshProjects = useCallback(async () => setProjects(await dl().projects()), []);

  // mount: load logs, session, panes, projects; subscribe to live updates.
  useEffect(() => {
    void (async () => {
      setEntries(await dl().getLogs({ limit: 1000 }));
      const s = await dl().session();
      setUrl(s.url ?? "");
      if (s.steps?.length) setSteps(s.steps);
      await refreshPanes();
      await refreshProjects();
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
  }, [sidebarHidden, settingsOpen, panes.length]);

  // auto-scroll timeline to bottom on new entries.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [entries]);

  // The embedded pane is a native layer above the DOM — detach it while the lightbox is open.
  useEffect(() => {
    void dl().overlay(lightbox !== null);
  }, [lightbox]);

  const saveSession = useCallback(() => {
    void dl().sessionSave({ cmd: devCmd.trim(), cwd: devCwd.trim(), url: url.trim(), steps });
  }, [devCmd, devCwd, url, steps]);

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

  // dev controls
  const onPlay = useCallback(async () => {
    if (devRunning) {
      await dl().devStop();
    } else if (!dev?.cmd && !dev?.cwd) {
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

  // repro
  const runRepro = useCallback(
    async (actions: Step[]) => {
      if (!actions.length) {
        setReproStatus("add a step first");
        return;
      }
      setReproStatus("running…");
      const r = await dl().repro({ actions, clear: false });
      const stopped = r.stoppedAtStep === null ? "" : ` · stopped@${r.stoppedAtStep}`;
      setReproStatus(`${r.stepCount} steps · ${r.errorCount} errors${stopped}`);
      const now = Date.now();
      const rows: Entry[] = [{ seq: -1, ts: now, source: "repro", stream: "summary", line: `▶ repro · ${r.stepCount} steps · ${r.errorCount} errors${stopped}` }];
      for (const s of r.steps) rows.push({ seq: -1, ts: now, source: "repro", stream: "step", line: `   ${s.index}. ${s.action.kind} ${s.error ? "✗ " + s.error : "✓"}` });
      for (const e of r.errors) rows.push({ seq: -1, ts: now, source: "repro", stream: "error", line: `   ✗ [${e.source}:${e.stream}] ${e.line}` });
      setEntries((cur) => [...cur, ...rows]);
      saveSession();
    },
    [saveSession],
  );

  // expose a test hook for the headless selftest (drive repro without React-controlled inputs).
  useEffect(() => {
    (window as unknown as { __devloopTest?: unknown }).__devloopTest = { runRepro };
  }, [runRepro]);

  const fillFromProject = (name: string) => {
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    setDevCwd(p.cwd);
    setDevCmd(p.cmd ?? "");
    setUrl(p.url ?? "");
    setPname(p.name);
    setSteps(p.steps?.length ? p.steps : [{ kind: "navigate" }]);
  };

  const shown = entries.filter((e) => {
    if (filter && !e.line.toLowerCase().includes(filter.toLowerCase())) return false;
    if (errOnly && !isErr(e)) return false;
    if (filterTarget && e.target && e.target !== filterTarget) return false;
    return true;
  });

  return (
    <>
      <div className="toolbar">
        <div className="bar">
          <div className="tabs">
            <span className={`tab${filterTarget === null ? " active" : ""}`} onClick={() => setFilterTarget(null)}>
              all
            </span>
            {panes.map((p) => (
              <span
                key={p.id}
                className={`tab${p.active ? " active" : ""}${p.dev?.running ? " run" : ""}`}
                onClick={async () => {
                  await dl().paneSelect(p.id);
                  setFilterTarget(p.id);
                  await refreshPanes();
                }}
              >
                <span className="dot" />
                <span className="name">{(p.label ?? p.id) + (p.popped ? " ⤢" : "")}</span>
                <span
                  className="x"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void dl().paneClose(p.id).then(refreshPanes);
                  }}
                >
                  ×
                </span>
              </span>
            ))}
            <span className="tab add" onClick={() => void dl().paneNew().then(refreshPanes)}>
              + pane
            </span>
          </div>

          <div className="spacer" />

          <span className={`chip${devRunning ? " run" : ""}${devFailed ? " fail" : ""}`}>
            {devRunning
              ? `● ${dev?.name ?? active?.label ?? "dev"}`
              : devFailed
                ? `✗ exited (code ${dev?.exitCode})`
                : dev?.cmd || dev?.cwd
                  ? "dev: stopped"
                  : "dev: not configured"}
          </span>
          <div className="group">
            <button className="icon" title="start / stop dev server" onClick={onPlay}>
              {devRunning ? "⏹" : "▶"}
            </button>
            <button className="icon" title="restart dev server" onClick={() => void dl().devRestart().then(refreshPanes)}>
              ⟳
            </button>
            <button className="icon" title="refresh page" onClick={() => void dl().reload(false)}>
              ⟲
            </button>
            <button className="icon" title="hard refresh (ignore cache)" onClick={() => void dl().reload(true)}>
              ⤓
            </button>
            <button className="icon" title="screenshot → timeline" onClick={() => void dl().screenshot()}>
              📷
            </button>
          </div>
          <div className="sep" />
          <div className="group">
            <button className="icon" title="settings" onClick={() => setSettingsOpen((v) => !v)}>
              ⚙
            </button>
            <button
              className="icon"
              title="pop active pane into its own window"
              onClick={async () => {
                if (active && !active.popped) await dl().panePop(active.id);
                await refreshPanes();
              }}
            >
              ⤢
            </button>
            <button title="toggle timeline" onClick={() => setSidebarHidden((v) => !v)}>
              {sidebarHidden ? "timeline ⟩" : "⟨ timeline"}
            </button>
          </div>
        </div>

        {settingsOpen && (
          <div className="settings">
            <div className="row">
              <input
                id="url"
                placeholder="3000  or  http://localhost:3000  →  Enter"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void navigate()}
              />
              <button onClick={() => void navigate()}>go</button>
              <select
                value={selProject}
                onChange={(e) => {
                  setSelProject(e.target.value);
                  if (e.target.value) fillFromProject(e.target.value);
                }}
              >
                <option value="">— project —</option>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                onClick={async () => {
                  if (!selProject) return;
                  fillFromProject(selProject);
                  const res = await dl().openProject(selProject);
                  await labelActive(res.name);
                  saveSession();
                  await refreshPanes();
                }}
              >
                open
              </button>
              <input placeholder="save as…" style={{ maxWidth: 120 }} value={pname} onChange={(e) => setPname(e.target.value)} />
              <button
                onClick={async () => {
                  if (!pname.trim() || !devCwd.trim()) return;
                  await dl().projectAdd({ name: pname.trim(), cwd: devCwd.trim(), cmd: devCmd.trim() || undefined, url: url.trim() || undefined, steps });
                  await refreshProjects();
                }}
              >
                save
              </button>
            </div>
            <div className="row">
              <input placeholder="dev cmd (blank = auto-detect)" value={devCmd} onChange={(e) => setDevCmd(e.target.value)} />
              <button
                title="browse"
                onClick={async () => {
                  const dir = await dl().pickFolder();
                  if (!dir) return;
                  setDevCwd(dir);
                  if (!pname.trim()) setPname(dir.split("/").filter(Boolean).pop() ?? "");
                }}
              >
                📁
              </button>
              <input placeholder="project cwd" value={devCwd} onChange={(e) => setDevCwd(e.target.value)} />
              <button
                onClick={async () => {
                  await dl().setDevConfig({ cmd: devCmd.trim() || undefined, cwd: devCwd.trim() || undefined });
                  await refreshPanes();
                }}
              >
                set dev config
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="body">
        <div className="pane-area" ref={paneAreaRef}>
          {panes.length === 0 && <div className="hint">no pane — open a project or add a pane (+)</div>}
        </div>

        <div className={`sidebar${sidebarHidden ? " hidden" : ""}`}>
          <div className="repro-head">
            <strong>repro</strong>
            <button onClick={() => setSteps((s) => [...s, { kind: "navigate" }])}>+ step</button>
            <button onClick={() => void runRepro(steps)}>run ▶</button>
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

          <div className="filterbar">
            <input placeholder="filter (substring)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label>
              <input type="checkbox" checked={errOnly} onChange={(e) => setErrOnly(e.target.checked)} /> errors only
            </label>
            <button
              onClick={async () => {
                await dl().clear();
                setEntries([]);
              }}
            >
              clear
            </button>
          </div>

          <div className="list" id="list" ref={listRef}>
            {shown.map((e, i) => (
              <div key={i} className={`logrow ${e.source}${isErr(e) ? " err" : ""}`}>
                <span className="ts">{fmtTime(e.ts)}</span>
                <span className="tag">
                  {e.source}:{e.stream}
                </span>
                {e.target && <span className="tgt">{e.target}</span>}
                {e.stream === "screenshot" && e.detail?.image ? (
                  <img className="shot" src={e.detail.image} onClick={() => setLightbox(e.detail!.image!)} />
                ) : (
                  <span className="msg">{e.line}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} />
        </div>
      )}
    </>
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
        ×
      </span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
