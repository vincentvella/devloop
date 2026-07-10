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
  source: "server" | "browser" | "native" | "repro";
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

export interface Ext {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

export interface NativeInfo {
  isNative: boolean;
  platforms: string[];
  targets: string[];
  buildStatus: string;
  badge: string | null;
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
  updateDownload: () => Promise<void>;
  updateInstall: () => Promise<void>;
  nativeEnv: () => Promise<{ ready: boolean; checks: { label: string; ok: boolean; fix?: string }[] }>;
  nativeElements: () => Promise<{ ref: string; role: string; name: string }[]>;
  openExtensions: () => Promise<void>;
  nativeInfo: (cwd: string) => Promise<NativeInfo>;
  nativeBuild: (cwd: string, platform: string) => Promise<{ started: boolean }>;
  openSimulator: () => Promise<{ ok: boolean }>;
  closeSimulator: () => Promise<{ ok: boolean }>;
  androidEnv: () => Promise<{ ready: boolean; checks: { label: string; ok: boolean; fix?: string }[]; summary: string }>;
  androidBuild: () => Promise<{
    ready: boolean;
    checks: { label: string; ok: boolean; fix?: string }[];
    summary: string;
  }>;
  doctor: () => Promise<{
    ios: { ready: boolean; checks: { label: string; ok: boolean; fix?: string }[]; summary: string };
    androidInteractions: { ready: boolean; checks: { label: string; ok: boolean; fix?: string }[]; summary: string };
    androidBuild: { ready: boolean; checks: { label: string; ok: boolean; fix?: string }[]; summary: string };
  }>;
  openAndroid: () => Promise<{ ok: boolean; serial?: string; summary?: string }>;
  closeAndroid: () => Promise<{ ok: boolean }>;
  androidTap: (x: number, y: number) => Promise<void>;
  androidText: (text: string) => Promise<void>;
  androidKey: (key: string) => Promise<void>;
  reload: (hard: boolean) => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  screenshot: () => Promise<void>;
  emulate: (opts: { device?: string; reset?: boolean }) => Promise<void>;
  throttle: (profile: string) => Promise<void>;
  pick: () => Promise<string | null>;
  clearStorage: (opts?: { allOrigins?: boolean }) => Promise<void>;
  exportBundle: () => Promise<string | null>;
  reportBug: () => Promise<void>;
  extList: () => Promise<Ext[]>;
  extInstall: (input: string) => Promise<Ext[]>;
  extLoadUnpacked: () => Promise<Ext[] | null>;
  extRemove: (id: string) => Promise<Ext[]>;
  extSetEnabled: (id: string, enabled: boolean) => Promise<Ext[]>;
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
  onExtChanged: (cb: () => void) => () => void;
  onNativeRefresh: (cb: (cwd: string) => void) => () => void;
  onPush: (cb: (rows: Entry[]) => void) => () => void;
  onUpdate: (cb: (status: import("../../src/update.ts").UpdateStatus) => void) => () => void;
  onAndroidFrame: (cb: (base64: string) => void) => () => void;
  onAndroidSize: (cb: (size: { width: number; height: number }) => void) => () => void;
}

declare global {
  interface Window {
    devloop: DevloopApi;
  }
}
