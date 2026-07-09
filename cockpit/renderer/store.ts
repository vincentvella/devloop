/**
 * Domain/IPC state extracted from the App component into a zustand store: the
 * log stream + project list + extension list, plus the IPC subscriptions that
 * keep them live. App reads these via selectors instead of holding them (and the
 * onPush/onExtChanged wiring) inline.
 *
 * `panes` stays in the component for now — it's coupled to local form state
 * (devCmd/devCwd) and is a separate follow-up slice.
 */
import { create } from "zustand";
import type { Entry, Ext, NativeInfo, Pane, Project } from "./global";

const dl = () => window.devloop;
const MAX_ENTRIES = 2000;

interface DevloopState {
  panes: Pane[];
  entries: Entry[];
  projects: Project[];
  exts: Ext[];
  nativeInfo: NativeInfo | null;

  /** Refresh the pane list. Returns it so the caller can sync derived UI (dev cmd/cwd). */
  refreshPanes: () => Promise<Pane[]>;

  setNativeInfo: (info: NativeInfo | null) => void;

  setEntries: (entries: Entry[]) => void;
  appendEntry: (e: Entry) => void;
  appendEntries: (rows: Entry[]) => void;
  clearEntries: () => void;

  setExts: (exts: Ext[]) => void;
  refreshProjects: () => Promise<void>;

  /** Initial load of entries/projects/exts + wire the IPC subscriptions. Called once. */
  init: () => Promise<void>;
}

export const useDevloopStore = create<DevloopState>((set, get) => ({
  panes: [],
  entries: [],
  projects: [],
  exts: [],
  nativeInfo: null,

  refreshPanes: async () => {
    const panes = await dl().panes();
    set({ panes });
    return panes;
  },

  setNativeInfo: (nativeInfo) => set({ nativeInfo }),

  setEntries: (entries) => set({ entries }),
  appendEntry: (e) => set((s) => ({ entries: [...s.entries.slice(-(MAX_ENTRIES - 1)), e] })),
  appendEntries: (rows) => set((s) => ({ entries: [...s.entries, ...rows].slice(-MAX_ENTRIES) })),
  clearEntries: () => set({ entries: [] }),

  setExts: (exts) => set({ exts }),
  refreshProjects: async () => set({ projects: await dl().projects() }),

  init: async () => {
    set({ entries: (await dl().getLogs({ limit: 1000 })).map((e) => ({ ...e })) });
    await get().refreshProjects();
    set({ exts: await dl().extList() });
    dl().onPush((rows) => get().appendEntries(rows as Entry[])); // batched (one set() per ~50ms flush)
    dl().onExtChanged(
      () =>
        void dl()
          .extList()
          .then((exts) => set({ exts })),
    );
  },
}));
