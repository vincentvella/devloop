/**
 * Preload — exposes a minimal, safe IPC surface to the timeline renderer.
 * contextIsolation is on, so the renderer only sees `window.devloop`.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("devloop", {
  getLogs: (opts?: unknown) => ipcRenderer.invoke("devloop:getLogs", opts),
  devStatus: () => ipcRenderer.invoke("devloop:devStatus"),
  clear: () => ipcRenderer.invoke("devloop:clear"),
  navigate: (url: string) => ipcRenderer.invoke("devloop:navigate", url),
  checkForUpdates: () => ipcRenderer.invoke("devloop:checkForUpdates"),
  nativeEnv: () => ipcRenderer.invoke("devloop:nativeEnv"),
  nativeElements: () => ipcRenderer.invoke("devloop:nativeElements"),
  updateDownload: () => ipcRenderer.invoke("devloop:updateDownload"),
  updateInstall: () => ipcRenderer.invoke("devloop:updateInstall"),
  openExtensions: () => ipcRenderer.invoke("devloop:openExtensions"),
  reportBug: () => ipcRenderer.invoke("devloop:reportBug"),
  nativeInfo: (cwd: string) => ipcRenderer.invoke("devloop:nativeInfo", cwd),
  nativeBuild: (cwd: string, platform: string) => ipcRenderer.invoke("devloop:nativeBuild", cwd, platform),
  openSimulator: () => ipcRenderer.invoke("devloop:openSimulator"),
  closeSimulator: () => ipcRenderer.invoke("devloop:closeSimulator"),
  androidEnv: () => ipcRenderer.invoke("devloop:androidEnv"),
  androidBuild: () => ipcRenderer.invoke("devloop:androidBuild"),
  doctor: () => ipcRenderer.invoke("devloop:doctor"),
  openAndroid: () => ipcRenderer.invoke("devloop:openAndroid"),
  closeAndroid: () => ipcRenderer.invoke("devloop:closeAndroid"),
  androidTap: (x: number, y: number) => ipcRenderer.invoke("devloop:androidTap", x, y),
  androidText: (text: string) => ipcRenderer.invoke("devloop:androidText", text),
  androidKey: (key: string) => ipcRenderer.invoke("devloop:androidKey", key),
  devStart: (opts: { cmd?: string; cwd?: string }) => ipcRenderer.invoke("devloop:devStart", opts),
  devStop: () => ipcRenderer.invoke("devloop:devStop"),
  devRestart: () => ipcRenderer.invoke("devloop:devRestart"),
  setDevConfig: (opts: { cmd?: string; cwd?: string }) => ipcRenderer.invoke("devloop:setDevConfig", opts),
  reload: (hard: boolean) => ipcRenderer.invoke("devloop:reload", hard),
  back: () => ipcRenderer.invoke("devloop:back"),
  forward: () => ipcRenderer.invoke("devloop:forward"),
  screenshot: () => ipcRenderer.invoke("devloop:screenshot"),
  emulate: (opts: { device?: string; reset?: boolean }) => ipcRenderer.invoke("devloop:emulate", opts),
  throttle: (profile: string) => ipcRenderer.invoke("devloop:throttle", profile),
  pick: () => ipcRenderer.invoke("devloop:pick"),
  clearStorage: (opts?: { allOrigins?: boolean }) => ipcRenderer.invoke("devloop:clearStorage", opts),
  exportBundle: () => ipcRenderer.invoke("devloop:exportBundle"),
  extList: () => ipcRenderer.invoke("devloop:extList"),
  extInstall: (input: string) => ipcRenderer.invoke("devloop:extInstall", input),
  extLoadUnpacked: () => ipcRenderer.invoke("devloop:extLoadUnpacked"),
  extRemove: (id: string) => ipcRenderer.invoke("devloop:extRemove", id),
  extSetEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("devloop:extSetEnabled", id, enabled),
  exportHar: () => ipcRenderer.invoke("devloop:exportHar"),
  // pane-targeted variants (used by a popped-out pane's own browser bar)
  navigateFor: (id: string, url: string) => ipcRenderer.invoke("devloop:navigateFor", id, url),
  backFor: (id: string) => ipcRenderer.invoke("devloop:backFor", id),
  forwardFor: (id: string) => ipcRenderer.invoke("devloop:forwardFor", id),
  reloadFor: (id: string, hard: boolean) => ipcRenderer.invoke("devloop:reloadFor", id, hard),
  screenshotFor: (id: string) => ipcRenderer.invoke("devloop:screenshotFor", id),
  setBoundsFor: (id: string, rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("devloop:setBoundsFor", id, rect),
  pickFolder: () => ipcRenderer.invoke("devloop:pickFolder"),
  projects: () => ipcRenderer.invoke("devloop:projects"),
  projectAdd: (p: { name: string; cwd: string; cmd?: string; url?: string }) =>
    ipcRenderer.invoke("devloop:projectAdd", p),
  openProject: (name: string) => ipcRenderer.invoke("devloop:openProject", name),
  panes: () => ipcRenderer.invoke("devloop:panes"),
  paneNew: (url?: string) => ipcRenderer.invoke("devloop:paneNew", url),
  paneSelect: (id: string) => ipcRenderer.invoke("devloop:paneSelect", id),
  paneClose: (id: string) => ipcRenderer.invoke("devloop:paneClose", id),
  panePop: (id: string) => ipcRenderer.invoke("devloop:panePop", id),
  paneSetLabel: (id: string, label: string) => ipcRenderer.invoke("devloop:paneSetLabel", id, label),
  setBounds: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("devloop:setBounds", rect),
  overlay: (on: boolean) => ipcRenderer.invoke("devloop:overlay", on),
  repro: (args: unknown) => ipcRenderer.invoke("devloop:repro", args),
  session: () => ipcRenderer.invoke("devloop:session"),
  sessionSave: (s: unknown) => ipcRenderer.invoke("devloop:sessionSave", s),
  onPanesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("devloop:panesChanged", handler);
    return () => ipcRenderer.removeListener("devloop:panesChanged", handler);
  },
  onExtChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("devloop:extChanged", handler);
    return () => ipcRenderer.removeListener("devloop:extChanged", handler);
  },
  onNativeRefresh: (cb: (cwd: string) => void) => {
    const handler = (_e: unknown, cwd: string) => cb(cwd);
    ipcRenderer.on("devloop:nativeRefresh", handler);
    return () => ipcRenderer.removeListener("devloop:nativeRefresh", handler);
  },
  onPush: (cb: (rows: unknown[]) => void) => {
    // Payload is a coalesced BATCH of entries (see main.ts) — forward the array.
    const handler = (_e: unknown, rows: unknown[]) => cb(rows);
    ipcRenderer.on("devloop:push", handler);
    return () => ipcRenderer.removeListener("devloop:push", handler);
  },
  onUpdate: (cb: (status: unknown) => void) => {
    const handler = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("devloop:update", handler);
    return () => ipcRenderer.removeListener("devloop:update", handler);
  },
  onAndroidFrame: (cb: (base64: string) => void) => {
    const handler = (_e: unknown, b64: string) => cb(b64);
    ipcRenderer.on("devloop:androidFrame", handler);
    return () => ipcRenderer.removeListener("devloop:androidFrame", handler);
  },
  onAndroidSize: (cb: (size: { width: number; height: number }) => void) => {
    const handler = (_e: unknown, size: { width: number; height: number }) => cb(size);
    ipcRenderer.on("devloop:androidSize", handler);
    return () => ipcRenderer.removeListener("devloop:androidSize", handler);
  },
});
