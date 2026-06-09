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
  devStart: (opts: { cmd?: string; cwd?: string }) => ipcRenderer.invoke("devloop:devStart", opts),
  devStop: () => ipcRenderer.invoke("devloop:devStop"),
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
  setBounds: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("devloop:setBounds", rect),
  repro: (args: unknown) => ipcRenderer.invoke("devloop:repro", args),
  session: () => ipcRenderer.invoke("devloop:session"),
  sessionSave: (s: unknown) => ipcRenderer.invoke("devloop:sessionSave", s),
  onPanesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("devloop:panesChanged", handler);
    return () => ipcRenderer.removeListener("devloop:panesChanged", handler);
  },
  onPush: (cb: (entry: unknown) => void) => {
    const handler = (_e: unknown, entry: unknown) => cb(entry);
    ipcRenderer.on("devloop:push", handler);
    return () => ipcRenderer.removeListener("devloop:push", handler);
  },
});
