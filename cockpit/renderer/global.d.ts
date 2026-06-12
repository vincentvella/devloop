export interface NetDetail {
  kind?: string;
  url?: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  failure?: string;
}

export interface Entry {
  seq: number;
  ts: number;
  source: "server" | "browser" | "repro";
  stream: string;
  line: string;
  target?: string;
  detail?: ({ image?: string } & NetDetail) | undefined;
}

export interface DevStatus {
  running: boolean;
  cmd?: string;
  cwd?: string;
  name?: string;
  exitCode?: number | null;
}

export interface Pane {
  id: string;
  url: string;
  active: boolean;
  popped?: boolean;
  label?: string;
  dev?: { running: boolean; name?: string; cmd?: string; cwd?: string; exitCode?: number | null };
  nav?: { canBack: boolean; canForward: boolean };
}

export interface Step {
  kind: string;
  url?: string;
  selector?: string;
  text?: string;
  expression?: string;
}

export interface Project {
  name: string;
  cwd: string;
  cmd?: string;
  url?: string;
  steps?: Step[];
}

export interface ReproResult {
  stepCount: number;
  errorCount: number;
  stoppedAtStep: number | null;
  steps: { index: number; action: { kind: string }; error?: string }[];
  errors: { source: string; stream: string; line: string }[];
}

export interface Session {
  cmd?: string;
  cwd?: string;
  url?: string;
  steps?: Step[];
  project?: string;
  pname?: string;
}

export interface DevloopApi {
  getLogs: (opts?: { limit?: number }) => Promise<Entry[]>;
  clear: () => Promise<boolean>;
  navigate: (url: string) => Promise<{ url: string; status: number | null }>;
  devStatus: () => Promise<DevStatus>;
  devStart: (opts: { cmd?: string; cwd?: string }) => Promise<DevStatus>;
  devStop: () => Promise<boolean>;
  devRestart: () => Promise<DevStatus>;
  setDevConfig: (opts: { cmd?: string; cwd?: string }) => Promise<void>;
  checkForUpdates: () => Promise<void>;
  reload: (hard: boolean) => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  screenshot: () => Promise<void>;
  pick: () => Promise<string | null>;
  clearStorage: (opts?: { allOrigins?: boolean }) => Promise<void>;
  exportBundle: () => Promise<string | null>;
  extList: () => Promise<{ id: string; name: string; version: string }[]>;
  extInstall: (input: string) => Promise<{ id: string; name: string; version: string }[]>;
  extLoadUnpacked: () => Promise<{ id: string; name: string; version: string }[] | null>;
  extRemove: (id: string) => Promise<{ id: string; name: string; version: string }[]>;
  exportHar: () => Promise<string | null>;
  navigateFor: (id: string, url: string) => Promise<{ url: string; status: number | null }>;
  backFor: (id: string) => Promise<void>;
  forwardFor: (id: string) => Promise<void>;
  reloadFor: (id: string, hard: boolean) => Promise<void>;
  screenshotFor: (id: string) => Promise<void>;
  setBoundsFor: (id: string, rect: { x: number; y: number; width: number; height: number }) => Promise<void>;
  pickFolder: () => Promise<string | null>;
  projects: () => Promise<Project[]>;
  projectAdd: (p: Project) => Promise<Project[]>;
  openProject: (name: string) => Promise<{ dev: DevStatus; url: string | null; name: string }>;
  panes: () => Promise<Pane[]>;
  paneNew: (url?: string) => Promise<Pane>;
  paneSelect: (id: string) => Promise<Pane>;
  paneClose: (id: string) => Promise<boolean>;
  panePop: (id: string) => Promise<Pane>;
  paneSetLabel: (id: string, label: string) => Promise<void>;
  setBounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>;
  overlay: (on: boolean) => Promise<void>;
  repro: (args: unknown) => Promise<ReproResult>;
  session: () => Promise<Session>;
  sessionSave: (s: Session) => Promise<void>;
  onPanesChanged: (cb: () => void) => () => void;
  onPush: (cb: (e: Entry) => void) => () => void;
}

declare global {
  interface Window {
    devloop: DevloopApi;
  }
}
