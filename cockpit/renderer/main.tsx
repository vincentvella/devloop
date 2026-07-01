import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bug,
  Camera,
  Crosshair,
  Eraser,
  ExternalLink,
  FolderOpen,
  Hammer,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  RotateCw,
  Save,
  Settings,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type UpdateStatus, updateStatusLabel } from "../../src/update.ts";
import type { Entry, Pane, Project, Step } from "./global";
import { useDevloopStore } from "./store";

const dl = () => window.devloop;

// Accessible icon button with a Radix tooltip.
function IconBtn({
  tip,
  onClick,
  children,
  disabled,
}: {
  tip: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
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

/** Full-width software-update banner: a spinner while checking/downloading, a
 *  progress bar with percent, and in-app Download / Restart actions (no native
 *  dialogs). Renders nothing when idle. */
function UpdateBanner({
  status,
  onDownload,
  onInstall,
  onDismiss,
}: {
  status: UpdateStatus;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
}): ReactNode {
  if (status.state === "idle") return null;
  const spinning = status.state === "checking" || status.state === "downloading";
  const tone = status.state === "error" ? "bad" : status.state === "downloaded" ? "ok" : "info";
  const dismissible =
    status.state === "available" ||
    status.state === "downloaded" ||
    status.state === "error" ||
    status.state === "uptodate";
  return (
    <div className={`update-banner ${tone}`}>
      {spinning ? <span className="update-spinner" /> : <span className="update-dot" />}
      <span className="update-text">{updateStatusLabel(status)}</span>
      {status.state === "downloading" && (
        <span className="update-progress">
          <span className="update-progress-fill" style={{ width: `${Math.round(status.percent)}%` }} />
        </span>
      )}
      <span className="update-spacer" />
      {status.state === "available" && (
        <button className="update-btn primary" onClick={onDownload}>
          Download
        </button>
      )}
      {status.state === "downloaded" && (
        <button className="update-btn primary" onClick={onInstall}>
          Restart to install
        </button>
      )}
      {dismissible && (
        <button className="update-btn ghost" aria-label="dismiss update" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  );
}

type NativeEnv = { ready: boolean; checks: { label: string; ok: boolean; fix?: string }[] } | null;

/** Preflight checklist for driving the iOS simulator (idb + companion + a booted sim),
 *  each row a ✓/✗ with the install fix when it's missing. */
function NativeReadiness({ data, onRecheck }: { data: NativeEnv; onRecheck: () => void }): ReactNode {
  return (
    <div className="native-readiness">
      {!data ? (
        <div className="ext-empty">checking…</div>
      ) : (
        data.checks.map((c) => (
          <div key={c.label} className={`native-check ${c.ok ? "ok" : "bad"}`}>
            <span className="native-mark">{c.ok ? "✓" : "✗"}</span>
            <span className="native-label">{c.label}</span>
            {!c.ok && c.fix && <code className="native-fix">{c.fix}</code>}
          </div>
        ))
      )}
      <button className="labeled" title="re-run the native readiness checks" onClick={onRecheck}>
        <RefreshCw size={13} /> re-check
      </button>
    </div>
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
    (e.stream === "network" &&
      (!!e.detail?.failure || e.detail?.status === undefined || (e.detail?.status ?? 0) >= 400)) ||
    (e.stream === "console" && /\[error\]/.test(e.line)) ||
    (e.source === "native" && (e.stream === "error" || e.stream === "fault")) ||
    (e.source === "server" && /error|exception|traceback|unhandled/i.test(e.line)) ||
    (e.source === "repro" && e.line.includes("✗"))
  );
}
/** Status-tier class for a network row's tag. */
function netTier(e: Entry): string | undefined {
  if (e.stream !== "network") return undefined;
  const d = e.detail;
  if (d?.failure) return "s5";
  const s = d?.status;
  if (s == null) return undefined;
  return s >= 500 ? "s5" : s >= 400 ? "s4" : s >= 300 ? "s3" : "s2";
}
const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const CHIPS: { key: string; label: string; test: (e: Entry) => boolean }[] = [
  { key: "server", label: "server", test: (e) => e.source === "server" },
  { key: "native", label: "native", test: (e) => e.source === "native" },
  { key: "console", label: "console", test: (e) => e.stream === "console" },
  { key: "network", label: "network", test: (e) => e.stream === "network" },
  { key: "errors", label: "errors", test: isErr },
  { key: "repro", label: "repro", test: (e) => e.source === "repro" },
];

let reproUid = -1; // unique negative keys for client-side repro rows

// --- log row (own expand state) -------------------------------------------
function HeaderList({ title, h }: { title: string; h?: Record<string, string> }) {
  const keys = h ? Object.keys(h) : [];
  if (!keys.length) return null;
  return (
    <div className="net-sec">
      <div className="net-h">{title}</div>
      {keys.map((k) => (
        <div key={k} className="net-hdr">
          <span className="net-k">{k}:</span> {h![k]}
        </div>
      ))}
    </div>
  );
}

function LogRow({ e, onZoom }: { e: Entry; onZoom: (img: string) => void }) {
  const [open, setOpen] = useState(false);
  const isNet = e.stream === "network" && !!e.detail?.url;
  const long = !isNet && (e.line.length > 220 || (e.line.match(/\n/g)?.length ?? 0) > 2);
  const cls = ["logrow", e.source];
  if (isErr(e)) cls.push("err");
  else if (e.stream === "console" && e.line.includes("[warning]")) cls.push("warn");
  const tier = netTier(e);
  if (tier) cls.push(tier);
  const d = e.detail;
  return (
    <div className={cls.join(" ")}>
      <span className="ts">{fmtTime(e.ts)}</span>
      <span className="tag">
        {e.source}:{e.stream}
      </span>
      {e.target && <span className="tgt">{e.target}</span>}
      {e.stream === "screenshot" && d?.image ? (
        <img className="shot" src={d.image} onClick={() => onZoom(d.image!)} />
      ) : isNet ? (
        <span className="msg net">
          <span
            onClick={() => setOpen((v) => !v)}
            title="click for request/response details"
            style={{ cursor: "pointer" }}
          >
            {e.line}
            {d?.durationMs != null ? <span className="net-ms"> · {Math.round(d.durationMs)}ms</span> : null}
          </span>
          {open && (
            <div className="net-detail">
              <div className="net-h">
                {d?.method} {d?.status ?? ""} {d?.statusText ?? d?.failure ?? ""} · {d?.resourceType ?? ""}{" "}
                {d?.mimeType ? "· " + d.mimeType : ""}
              </div>
              <HeaderList title="request headers" h={d?.requestHeaders} />
              {d?.requestBody ? (
                <div className="net-sec">
                  <div className="net-h">request body</div>
                  <pre className="net-body">{d.requestBody}</pre>
                </div>
              ) : null}
              <HeaderList title="response headers" h={d?.responseHeaders} />
              {d?.responseBody ? (
                <div className="net-sec">
                  <div className="net-h">response body</div>
                  <pre className="net-body">{d.responseBody}</pre>
                </div>
              ) : null}
            </div>
          )}
        </span>
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

const KEYMAP: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Escape: "Back",
};

/**
 * Live Android screen mirror (the parallel to serve-sim's iOS preview). Subscribes
 * to `screencap` frames and sets the <img> src IMPERATIVELY — multi-MB PNG data URLs
 * never enter React state, so a 2-3fps stream can't thrash reconciliation (an earlier
 * state-driven version OOM'd the renderer). Clicks/keys map to adb input; a click maps
 * from the rendered <img> rect back to device pixels via the reported `wm size`.
 */
function AndroidMirror(): ReactNode {
  const imgRef = useRef<HTMLImageElement>(null);
  const waitRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<{ width: number; height: number }>({ width: 1080, height: 2400 });

  useEffect(() => {
    const offSize = dl().onAndroidSize((s) => (sizeRef.current = s));
    const offFrame = dl().onAndroidFrame((b64) => {
      const img = imgRef.current;
      if (!img) return;
      img.src = `data:image/png;base64,${b64}`;
      if (waitRef.current) waitRef.current.style.display = "none";
      img.style.display = "block";
    });
    return () => {
      offSize();
      offFrame();
    };
  }, []);

  const onClick = (e: React.MouseEvent) => {
    const el = imgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const { width, height } = sizeRef.current;
    const x = ((e.clientX - r.left) / r.width) * width;
    const y = ((e.clientY - r.top) / r.height) * height;
    void dl().androidTap(x, y);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (KEYMAP[e.key]) {
      e.preventDefault();
      void dl().androidKey(KEYMAP[e.key]!);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void dl().androidText(e.key);
    }
  };
  return (
    <div className="android-mirror" tabIndex={0} onKeyDown={onKeyDown} title="click to tap · type to send keys">
      <img ref={imgRef} className="android-frame" style={{ display: "none" }} onClick={onClick} draggable={false} />
      <div ref={waitRef} className="android-waiting">
        connecting to device…
      </div>
    </div>
  );
}

// --- app -------------------------------------------------------------------
function App() {
  // Domain/IPC state lives in the zustand store (store.ts).
  const panes = useDevloopStore((s) => s.panes);
  const storeRefreshPanes = useDevloopStore((s) => s.refreshPanes);
  const entries = useDevloopStore((s) => s.entries);
  const projects = useDevloopStore((s) => s.projects);
  const exts = useDevloopStore((s) => s.exts);
  const setExts = useDevloopStore((s) => s.setExts);
  const refreshProjects = useDevloopStore((s) => s.refreshProjects);
  const appendEntries = useDevloopStore((s) => s.appendEntries);
  const clearEntries = useDevloopStore((s) => s.clearEntries);
  const [filter, setFilter] = useState("");
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false); // gear → global modal (extensions, updates)
  const [nativeEnv, setNativeEnv] = useState<{
    ready: boolean;
    checks: { label: string; ok: boolean; fix?: string }[];
  } | null>(null);
  const [androidEnv, setAndroidEnv] = useState<{
    ready: boolean;
    checks: { label: string; ok: boolean; fix?: string }[];
  } | null>(null);
  const [androidBuild, setAndroidBuild] = useState<NativeEnv>(null);
  const [emuDevice, setEmuDevice] = useState("responsive"); // #25 viewport picker (web)
  const [netProfile, setNetProfile] = useState("none"); // #25 throttle picker (web)
  const [wrenchOpen, setWrenchOpen] = useState(false); // wrench → active-pane modal (project, dev)
  const nativeInfo = useDevloopStore((s) => s.nativeInfo);
  const refreshNativeInfo = useDevloopStore((s) => s.refreshNativeInfo);
  const [building, setBuilding] = useState(false);
  const [viewTarget, setViewTarget] = useState("web"); // Expo: which target the pane shows (web | ios)
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(460);
  const [dragging, setDragging] = useState(false);
  const [selProject, setSelProject] = useState("");
  const [devCmd, setDevCmd] = useState("");
  const [devCwd, setDevCwd] = useState("");
  const [url, setUrl] = useState("");
  const [steps, setSteps] = useState<Step[]>([{ kind: "navigate" }]);
  const [reproStatus, setReproStatus] = useState("");
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [editingPane, setEditingPane] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [panelTab, setPanelTab] = useState<"logs" | "repro">("logs");
  const [picking, setPicking] = useState(false);
  const [nativePick, setNativePick] = useState<{ ref: string; role: string; name: string }[] | null>(null); // null = closed
  const [extInput, setExtInput] = useState("");

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

  // Wrap the store's pane refresh to also seed the editable dev cmd/cwd fields.
  const refreshPanes = useCallback(async () => {
    const ps = await storeRefreshPanes();
    const a = ps.find((p) => p.active);
    setDevCmd(a?.dev?.cmd ?? "");
    setDevCwd(a?.dev?.cwd ?? "");
  }, [storeRefreshPanes]);
  // Save the active pane's dev cmd/cwd (auto-applied on blur / folder pick).
  const applyDevConfig = useCallback(
    async (cmd: string, cwd: string) => {
      await dl().setDevConfig({ cmd: cmd.trim() || undefined, cwd: cwd.trim() || undefined });
      await refreshPanes();
    },
    [refreshPanes],
  );

  useEffect(() => {
    void useDevloopStore.getState().init(); // entries/projects/exts + onPush/onExtChanged
    void (async () => {
      const s = await dl().session();
      if (s.steps?.length) setSteps(s.steps);
      if (s.project) setSelProject(s.project);
      await refreshPanes();
      setLoaded(true);
    })();
    const offPanes = dl().onPanesChanged(() => void refreshPanes());
    const offUpdate = dl().onUpdate((s) => setUpdate(s));
    return () => {
      offPanes();
      offUpdate();
    };
  }, [refreshPanes]);

  // Refresh native (iOS) readiness for native projects (drives the gear badge) and
  // whenever the settings modal opens or the iOS target is shown.
  useEffect(() => {
    if (settingsOpen || viewTarget === "ios" || nativeInfo?.isNative) void dl().nativeEnv().then(setNativeEnv);
    if (settingsOpen && nativeInfo?.isNative) void dl().androidBuild().then(setAndroidBuild);
  }, [settingsOpen, viewTarget, nativeInfo?.isNative]);

  // Android readiness, refreshed when its target is shown (drives the warn bar).
  useEffect(() => {
    if (viewTarget === "android") void dl().androidEnv().then(setAndroidEnv);
  }, [viewTarget]);

  // Transient update states clear themselves; downloading/downloaded persist until acted on.
  useEffect(() => {
    if (update.state !== "uptodate" && update.state !== "error") return;
    const t = setTimeout(() => setUpdate({ state: "idle" }), 6000);
    return () => clearTimeout(t);
  }, [update]);

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
  }, [sidebarHidden, sidebarWidth, panes.length, fillTimeline]);

  // smart auto-scroll: only stick to bottom if already near it.
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [entries, atBottom]);

  // The browser pane is a native view layered above the DOM, so any DOM overlay
  // (lightbox or a settings modal) must detach it first or it renders behind.
  useEffect(() => {
    void dl().overlay(lightbox !== null || wrenchOpen || settingsOpen);
  }, [lightbox, wrenchOpen, settingsOpen]);

  // Probe whether the active pane's project is a native (Expo/RN) target — drives
  // the target switcher + build control. Runs on cwd change (not just wrench-open)
  // so the browser bar can show the Web/iOS switcher for Expo projects.
  useEffect(() => {
    if (!devCwd) {
      useDevloopStore.getState().setNativeInfo(null);
      return;
    }
    let live = true;
    void refreshNativeInfo(devCwd).then((info) => {
      if (live && info?.targets?.length && !info.targets.includes(viewTarget)) setViewTarget(info.targets[0]!);
    });
    return () => {
      live = false;
    };
  }, [devCwd, refreshNativeInfo]);

  // Switch an Expo project's view target: Web (browser pane) ↔ iOS (simulator) ↔ Android (mirror).
  const switchTarget = useCallback(
    async (t: string) => {
      const prev = viewTarget;
      setViewTarget(t);
      if (prev === "ios" && t !== "ios") await dl().closeSimulator();
      if (prev === "android" && t !== "android") await dl().closeAndroid();
      if (t === "ios") await dl().openSimulator();
      else if (t === "android") await dl().openAndroid();
    },
    [viewTarget],
  );

  const saveSession = useCallback(() => {
    void dl().sessionSave({ cmd: devCmd.trim(), cwd: devCwd.trim(), steps, project: selProject });
  }, [devCmd, devCwd, steps, selProject]);

  // Address bar follows the active pane's current URL (link clicks / SPA routes update it).
  useEffect(() => {
    setUrl(active?.url && active.url !== "about:blank" ? active.url : "");
  }, [active?.url]);

  // Emulation/throttle are per-pane (applied via the routed controller); reset the
  // pickers' display to neutral when the active pane changes so they don't imply a
  // setting the newly-shown pane doesn't have.
  useEffect(() => {
    setEmuDevice("responsive");
    setNetProfile("none");
  }, [active?.id]);

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
      setWrenchOpen(true); // no dev config yet → open the pane's wrench to set it
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
      const rows: Entry[] = [
        {
          seq: reproUid--,
          ts: now,
          source: "repro",
          stream: "summary",
          line: `▶ repro · ${r.stepCount} steps · ${r.errorCount} errors${stopped}`,
        },
      ];
      for (const s of r.steps)
        rows.push({
          seq: reproUid--,
          ts: now,
          source: "repro",
          stream: "step",
          line: `   ${s.index}. ${s.action.kind} ${s.error ? "✗ " + s.error : "✓"}`,
        });
      for (const e of r.errors)
        rows.push({
          seq: reproUid--,
          ts: now,
          source: "repro",
          stream: "error",
          line: `   ✗ [${e.source}:${e.stream}] ${e.line}`,
        });
      appendEntries(rows);
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
        clearEntries();
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
    await dl().projectAdd({
      name,
      cwd: devCwd.trim(),
      cmd: devCmd.trim() || undefined,
      url: url.trim() || undefined,
      steps,
    });
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
      <UpdateBanner
        status={update}
        onDownload={() => void dl().updateDownload()}
        onInstall={() => void dl().updateInstall()}
        onDismiss={() => setUpdate({ state: "idle" })}
      />
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
            <span className="tab add" data-testid="pane-add" onClick={() => void dl().paneNew().then(refreshPanes)}>
              <Plus size={13} /> pane
            </span>
          </div>

          <div className="spacer" />

          <IconBtn tip="extensions — browse the Chrome Web Store" onClick={() => void dl().openExtensions()}>
            <Puzzle size={15} />
          </IconBtn>
          <IconBtn tip="pane settings — project & dev server" onClick={() => setWrenchOpen(true)}>
            <Wrench size={15} />
          </IconBtn>
          <span className="icon-badge-wrap">
            <IconBtn
              tip={
                nativeInfo?.isNative && nativeEnv && !nativeEnv.ready
                  ? "settings — ⚠ native (iOS) readiness needs attention"
                  : "settings (⌘,) — extensions & updates"
              }
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={15} />
            </IconBtn>
            {nativeInfo?.isNative && nativeEnv && !nativeEnv.ready && (
              <span className="icon-badge" title="native readiness check failed" />
            )}
          </span>
        </div>
      </div>

      {!active?.popped && (
        <div className="browser-bar">
          <IconBtn tip="back" disabled={!active?.nav?.canBack} onClick={() => void dl().back().then(refreshPanes)}>
            <ArrowLeft size={15} />
          </IconBtn>
          <IconBtn
            tip="forward"
            disabled={!active?.nav?.canForward}
            onClick={() => void dl().forward().then(refreshPanes)}
          >
            <ArrowRight size={15} />
          </IconBtn>
          <IconBtn tip="reload page (⌘R)" onClick={() => void dl().reload(false)}>
            <RotateCw size={15} />
          </IconBtn>
          <IconBtn tip="hard reload — ignore cache (⌘⇧R)" onClick={() => void dl().reload(true)}>
            <RefreshCw size={15} />
          </IconBtn>
          <IconBtn
            tip="clear site data (cookies/localStorage) + reload"
            onClick={() =>
              void dl()
                .clearStorage()
                .then(() => dl().reload(false))
            }
          >
            <Eraser size={15} />
          </IconBtn>
          {nativeInfo?.isNative && nativeInfo.targets.length > 0 && (
            <div
              className="segmented target-switch"
              title="view target — Web (browser), iOS (simulator), or Android (device mirror)"
            >
              {nativeInfo.targets.map((t) => (
                <button key={t} className={`seg${viewTarget === t ? " on" : ""}`} onClick={() => void switchTarget(t)}>
                  {t === "web" ? "Web" : t === "ios" ? "iOS" : t === "android" ? "Android" : t}
                </button>
              ))}
            </div>
          )}
          {nativeInfo?.isNative && (viewTarget === "ios" || viewTarget === "android") && (
            <>
              <button
                className="labeled btn-primary"
                disabled={building}
                title={`build + launch the ${viewTarget} dev build (output → timeline)${nativeInfo.badge ? " · " + nativeInfo.badge : ""}`}
                onClick={() => {
                  setBuilding(true);
                  void dl()
                    .nativeBuild(devCwd, viewTarget)
                    .finally(() => setBuilding(false));
                }}
              >
                <Hammer size={13} /> {building ? "building…" : "Build"}
              </button>
              {nativeInfo.badge && (
                <span className="build-badge" title="run a build to refresh">
                  ⚠
                </span>
              )}
            </>
          )}
          <input
            ref={urlRef}
            className="address"
            placeholder="3000  or  http://localhost:3000  —  ↵ to open"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void navigate()}
          />
          {(!nativeInfo?.isNative || viewTarget === "web") && (
            <>
              <select
                className="bar-select"
                title="emulate a device viewport (browser_emulate)"
                value={emuDevice}
                onChange={(e) => {
                  const v = e.target.value;
                  setEmuDevice(v);
                  void dl().emulate(v === "responsive" ? { reset: true } : { device: v });
                }}
              >
                <option value="responsive">Responsive</option>
                <option value="iphone">iPhone</option>
                <option value="ipad">iPad</option>
                <option value="pixel">Pixel</option>
              </select>
              <select
                className="bar-select"
                title="throttle the network (browser_throttle)"
                value={netProfile}
                onChange={(e) => {
                  const v = e.target.value;
                  setNetProfile(v);
                  void dl().throttle(v);
                }}
              >
                <option value="none">No throttle</option>
                <option value="fast-3g">Fast 3G</option>
                <option value="slow-3g">Slow 3G</option>
                <option value="offline">Offline</option>
              </select>
            </>
          )}
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

      {viewTarget === "ios" && nativeEnv && !nativeEnv.ready && (
        <div className="native-warn" onClick={() => setSettingsOpen(true)} title="open Settings → native readiness">
          ⚠ Native taps & snapshot need idb —{" "}
          {nativeEnv.checks
            .filter((c) => !c.ok)
            .map((c) => c.label)
            .join(", ")}{" "}
          missing. Click for setup.
        </div>
      )}
      {viewTarget === "android" && androidEnv && !androidEnv.ready && (
        <div className="native-warn" title="Android readiness">
          ⚠ Android needs{" "}
          {androidEnv.checks
            .filter((c) => !c.ok)
            .map((c) => c.label)
            .join(", ")}{" "}
          — {androidEnv.checks.find((c) => !c.ok)?.fix}
        </div>
      )}

      <div className="body">
        <div className="pane-area" ref={paneAreaRef} style={fillTimeline ? { display: "none" } : undefined}>
          {panes.length === 0 && <div className="hint">no pane — open a project or add a pane (+)</div>}
          {viewTarget === "android" && <AndroidMirror />}
        </div>

        {!sidebarHidden && !fillTimeline && (
          <div className={`divider${dragging ? " drag" : ""}`} onMouseDown={startDrag} />
        )}

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
            <IconBtn
              tip={nativeInfo?.isNative ? "start / stop the bundler (Metro)" : "start / stop dev server"}
              onClick={() => void onPlay()}
            >
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
                <button
                  className="labeled"
                  title={
                    viewTarget === "ios"
                      ? "pick a native element (from the iOS accessibility tree)"
                      : "pick an element in the page → adds a click step"
                  }
                  disabled={picking}
                  onClick={async () => {
                    if (viewTarget === "ios") {
                      // Native: no DOM overlay — list the a11y elements and let the user choose.
                      setReproStatus("loading native elements…");
                      const nodes = await dl().nativeElements();
                      setNativePick(nodes);
                      setReproStatus(
                        nodes.length ? "" : "no native elements — is idb ready + the app in the foreground?",
                      );
                      return;
                    }
                    setPicking(true);
                    setReproStatus("pick an element… (Esc cancels)");
                    try {
                      const sel = await dl().pick();
                      if (sel) {
                        setSteps((s) => [...s, { kind: "click", selector: sel }]);
                        setReproStatus(`picked ${sel}`);
                      } else setReproStatus("pick cancelled");
                    } finally {
                      setPicking(false);
                    }
                  }}
                >
                  <Crosshair size={13} /> {picking ? "picking…" : "pick"}
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
                  {CHIPS.filter((c) => c.key !== "native" || nativeInfo?.isNative).map((c) => (
                    <span
                      key={c.key}
                      className={`fchip${chips.has(c.key) ? " on" : ""}`}
                      onClick={() => toggleChip(c.key)}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
                <button title="export captured network as a HAR file" onClick={() => void dl().exportHar()}>
                  HAR
                </button>
                <button title="export a shareable bug report (HTML)" onClick={() => void dl().exportBundle()}>
                  report
                </button>
                <button
                  onClick={async () => {
                    await dl().clear();
                    clearEntries();
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

      {/* Wrench — settings for the active pane (project + dev server). */}
      <Dialog.Root open={wrenchOpen} onOpenChange={setWrenchOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content" aria-describedby={undefined}>
            <Dialog.Title className="modal-title">
              <Wrench size={14} /> {active?.label ?? "pane"} — project & dev
            </Dialog.Title>
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
                <button
                  className="labeled"
                  title="save the active pane as a project (rename on its tab)"
                  onClick={() => void saveProject()}
                >
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
              {nativeInfo?.isNative && (
                <div className="row">
                  <span className="field-label">native</span>
                  <span className="ext-empty">
                    Use the Web/iOS switcher in the browser bar to run + build this target.
                  </span>
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Gear — global settings (extensions + updates), shared across panes. */}
      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content" aria-describedby={undefined}>
            <Dialog.Title className="modal-title">
              <Settings size={14} /> Settings
            </Dialog.Title>
            <div className="settings" data-testid="settings-panel">
              <div className="modal-section">extensions</div>
              <button
                className="labeled btn-block btn-primary"
                title="open the Chrome Web Store in its own window — click ‘Add to Chrome’ to install"
                onClick={() => {
                  setSettingsOpen(false);
                  void dl().openExtensions();
                }}
              >
                <Puzzle size={14} /> browse the Chrome Web Store
              </button>
              <div className="row">
                <input
                  placeholder="Web Store link or extension id"
                  value={extInput}
                  onChange={(e) => setExtInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !extInput.trim()) return;
                    void dl()
                      .extInstall(extInput.trim())
                      .then((list) => {
                        setExts(list);
                        setExtInput("");
                      })
                      .catch((err) =>
                        setReproStatus(`ext: ${(err as Error)?.message?.split(": ").pop() ?? "install failed"}`),
                      );
                  }}
                />
                <button
                  className="labeled"
                  title="install from the pasted id / URL"
                  onClick={() => {
                    if (!extInput.trim()) return;
                    void dl()
                      .extInstall(extInput.trim())
                      .then((list) => {
                        setExts(list);
                        setExtInput("");
                      })
                      .catch((err) =>
                        setReproStatus(`ext: ${(err as Error)?.message?.split(": ").pop() ?? "install failed"}`),
                      );
                  }}
                >
                  <Plus size={13} /> install
                </button>
                <IconBtn
                  tip="Load an unpacked extension — pick its folder"
                  onClick={() =>
                    void dl()
                      .extLoadUnpacked()
                      .then((l) => l && setExts(l))
                  }
                >
                  <FolderOpen size={14} />
                </IconBtn>
              </div>
              <div className="ext-hint">
                In the store window, use the “+ Add to Devloop” button (Google greys its own “Add to Chrome” outside
                Chrome). Or paste a Web Store link / id above.
              </div>
              {exts.length > 0 ? (
                <div className="ext-list" data-testid="ext-list">
                  {exts.map((x) => (
                    <span
                      key={x.id}
                      data-testid={`ext-chip-${x.id}`}
                      className={`ext-chip${x.enabled ? "" : " off"}`}
                      title={`${x.id} · v${x.version} — click to ${x.enabled ? "disable" : "enable"}`}
                    >
                      <span
                        className="ext-name"
                        onClick={() => void dl().extSetEnabled(x.id, !x.enabled).then(setExts)}
                      >
                        {x.name}
                      </span>
                      <span
                        className="x"
                        data-testid={`ext-remove-${x.id}`}
                        title="remove (uninstall)"
                        onClick={() => void dl().extRemove(x.id).then(setExts)}
                      >
                        <X size={13} />
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="ext-empty" data-testid="ext-empty">
                  No extensions installed yet.
                </div>
              )}
              <div className="modal-section">native (iOS) readiness</div>
              <NativeReadiness data={nativeEnv} onRecheck={() => void dl().nativeEnv().then(setNativeEnv)} />

              {nativeInfo?.isNative && (
                <>
                  <div className="modal-section">Android build toolchain</div>
                  <NativeReadiness
                    data={androidBuild}
                    onRecheck={() => void dl().androidBuild().then(setAndroidBuild)}
                  />
                </>
              )}

              <div className="modal-section">updates</div>
              <button
                className="labeled"
                title="check GitHub for a newer Devloop release"
                onClick={() => void dl().checkForUpdates()}
              >
                <RefreshCw size={13} /> check for updates
              </button>

              <div className="modal-section">feedback</div>
              <button
                className="labeled"
                title="open a prefilled bug report on GitHub (opens in your browser — review before submitting)"
                onClick={() => void dl().reportBug()}
              >
                <Bug size={13} /> report a bug
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Native (iOS) element picker — list the a11y tree (no DOM overlay on the sim). */}
      <Dialog.Root open={nativePick !== null} onOpenChange={(o) => !o && setNativePick(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal-content" aria-describedby={undefined}>
            <Dialog.Title className="modal-title">
              <Crosshair size={14} /> Pick a native element
            </Dialog.Title>
            <div className="native-pick-list">
              {nativePick && nativePick.length === 0 ? (
                <div className="ext-empty">No elements found — is idb ready and the app in the foreground?</div>
              ) : (
                nativePick?.map((n, i) => (
                  <button
                    key={`${n.ref}:${i}`}
                    className="native-pick-row"
                    onClick={() => {
                      const selector = n.name || n.ref; // controller resolves a label or a pt:x,y ref
                      setSteps((s) => [...s, { kind: "click", selector }]);
                      setReproStatus(`picked ${selector}`);
                      setNativePick(null);
                    }}
                  >
                    <span className="native-pick-role">{n.role}</span>
                    <span className="native-pick-name">{n.name || n.ref}</span>
                  </button>
                ))
              )}
            </div>
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
      {k === "type" && (
        <input
          placeholder="text"
          value={step.text ?? ""}
          onChange={(e) => onChange({ ...step, text: e.target.value })}
        />
      )}
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
        <IconBtn
          tip="forward"
          disabled={!pane?.nav?.canForward}
          onClick={() => void dl().forwardFor(paneId).then(refresh)}
        >
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
