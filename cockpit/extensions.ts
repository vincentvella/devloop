/**
 * Chrome-extension management for the cockpit — loaded into the panes' session
 * (not the shell's). Extracted from main.ts as a factory so the rest of the app
 * (IPC handlers, MCP ext_* tools, self-test) shares one handle. `getShellWin` is
 * a lazy getter because the shell window is created after this handle is built.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, session } from "electron";
import {
  installChromeWebStore,
  installExtension,
  loadAllExtensions,
  uninstallExtension,
} from "electron-chrome-web-store";
import { type ExtMeta, extensionIdFromInput, unifyExtensions } from "../src/extensions.ts";
import { DEFAULT_PARTITION } from "../src/partition.ts";
import {
  getDisabledExtensions,
  getUnpackedExtensions,
  setDisabledExtensions,
  setUnpackedExtensions,
} from "../src/registry.ts";

export interface ExtensionManagerDeps {
  BASE: string;
  log: (m: string) => void;
  getShellWin: () => BrowserWindow | undefined;
}

export type ExtensionManager = ReturnType<typeof createExtensionManager>;

export function createExtensionManager(deps: ExtensionManagerDeps) {
  const { BASE, log, getShellWin } = deps;

  // --- chrome extensions (loaded into the panes' session, not the shell's) ---
  const EXT_DIR = join(process.env.DEVLOOP_HOME ?? join(homedir(), ".devloop"), "extensions");
  const WEB_STORE_URL = "https://chromewebstore.google.com/";
  const unpackedById = new Map<string, string>(); // loaded unpacked extension id → source dir
  const extSession = () => session.fromPartition(DEFAULT_PARTITION);
  let extWin: BrowserWindow | undefined;

  /**
   * Browse the real Chrome Web Store in its own window (not a project pane — panes
   * carry the timeline). It uses the panes' session, so the preload + "Add to
   * Chrome" interception set up by installChromeWebStore apply and installs land
   * in the same session our panes use.
   */
  function openExtensionsWindow(): void {
    if (extWin && !extWin.isDestroyed()) {
      extWin.focus();
      return;
    }
    extWin = new BrowserWindow({
      // The Web Store layout has a ~1248px min-width before it reflows; below that
      // it scrolls horizontally (real Chrome does too). useContentSize makes these
      // the web viewport dimensions (not the outer frame), so the page actually fits.
      width: 1280,
      height: 860,
      minWidth: 1024,
      useContentSize: true,
      center: true,
      title: "Devloop — Extensions",
      icon: [join(BASE, "../assets/icon.png"), join(BASE, "assets/icon.png")].find(existsSync),
      // Inject our own "Add to Devloop" button — Google greys the native "Add to
      // Chrome" for non-Chrome browsers, so we install via the direct-CRX path instead.
      webPreferences: {
        partition: DEFAULT_PARTITION,
        contextIsolation: true,
        sandbox: false,
        preload: join(BASE, "extStorePreload.cjs"),
      },
    });
    extWin.on("closed", () => (extWin = undefined));
    void extWin.loadURL(WEB_STORE_URL);
  }
  /** Directory to (re)load an extension from: a tracked unpacked path, else the
   * web-store version dir under EXT_DIR/<id>/<version>. undefined if not found. */
  function extDir(id: string): string | undefined {
    const up = unpackedById.get(id);
    if (up && existsSync(join(up, "manifest.json"))) return up;
    const base = join(EXT_DIR, id);
    try {
      for (const v of readdirSync(base)) {
        const d = join(base, v);
        if (existsSync(join(d, "manifest.json"))) return d;
      }
    } catch {
      /* not installed */
    }
    return undefined;
  }

  /** Read a disabled extension's name/version from disk (it isn't loaded). */
  function extMeta(id: string): ExtMeta | null {
    const dir = extDir(id);
    if (!dir) return null;
    try {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      return { id, name: m.name ?? id, version: m.version ?? "?" };
    } catch {
      return null;
    }
  }

  /** Loaded extensions (enabled) + known-disabled ones, for the UI's toggle list. */
  const extList = () => {
    const loaded = extSession()
      .extensions.getAllExtensions()
      .map((e) => ({ id: e.id, name: e.name, version: e.version }));
    const disabled = getDisabledExtensions()
      .map(extMeta)
      .filter((m): m is ExtMeta => !!m);
    return unifyExtensions(loaded, disabled);
  };

  // Partitions whose extensions are already set up (#27 — one session per project). The
  // default partition is the canonical set; project sessions get the same extensions loaded.
  const preparedPartitions = new Set<string>();

  /** Prepare a session partition (idempotent): load all installed extensions + the Web Store
   *  hook into it, so a per-project pane has the same extensions as the default. */
  async function prepareSession(partition: string): Promise<void> {
    if (preparedPartitions.has(partition)) return;
    preparedPartitions.add(partition);
    await setupExtensionsFor(session.fromPartition(partition));
  }

  /** Run `fn` against every prepared session (so install/remove/toggle apply everywhere). */
  async function eachExtSession(
    fn: (ses: ReturnType<typeof session.fromPartition>) => Promise<void> | void,
  ): Promise<void> {
    for (const partition of preparedPartitions) await fn(session.fromPartition(partition));
  }

  /** Load an extension dir into every prepared session (best-effort; an already-loaded one throws → ignored). */
  async function loadExtIntoAll(dir: string): Promise<void> {
    await eachExtSession(async (ses) => {
      try {
        await ses.extensions.loadExtension(dir, { allowFileAccess: true });
      } catch {
        /* already loaded in this session, or bad dir */
      }
    });
  }

  /** Unload an extension id from every prepared session (loading it first if needed, so a
   *  disabled store extension's persisted settings entry is actually purged). */
  async function purgeExtFromAll(id: string): Promise<void> {
    await eachExtSession(async (ses) => {
      if (!ses.extensions.getExtension(id)) {
        const dir = extDir(id);
        if (dir) {
          try {
            await ses.extensions.loadExtension(dir, { allowFileAccess: true });
          } catch {
            /* can't load — removeExtension below will just no-op */
          }
        }
      }
      try {
        ses.extensions.removeExtension(id);
      } catch {
        /* not loaded */
      }
    });
  }

  // Extension operations shared by the cockpit IPC handlers and the MCP ext_* tools.
  async function doExtInstall(input: string) {
    const id = extensionIdFromInput(String(input));
    if (!id) throw new Error("not a valid extension id or Chrome Web Store URL");
    await installExtension(id, { session: extSession(), extensionsPath: EXT_DIR }); // downloads + loads into default
    const dir = extDir(id);
    if (dir) await loadExtIntoAll(dir); // mirror into every other per-project session (#27)
    return extList();
  }
  async function doExtSetEnabled(id: string, enabled: boolean) {
    const disabled = new Set(getDisabledExtensions());
    if (enabled) {
      const dir = extDir(id);
      if (dir) await loadExtIntoAll(dir);
      disabled.delete(id);
    } else {
      await purgeExtFromAll(id);
      disabled.add(id);
    }
    setDisabledExtensions([...disabled]);
    return extList();
  }
  async function doExtRemove(id: string) {
    setDisabledExtensions(getDisabledExtensions().filter((x) => x !== id));
    await purgeExtFromAll(id); // unload from every per-project session (#27), purging persisted settings
    if (unpackedById.has(id)) {
      const dir = unpackedById.get(id)!;
      unpackedById.delete(id);
      setUnpackedExtensions(getUnpackedExtensions().filter((p) => p !== dir));
    } else {
      try {
        await uninstallExtension(id, { session: extSession(), extensionsPath: EXT_DIR });
      } catch {
        /* store uninstall best-effort */
      }
    }
    if (extWin && !extWin.isDestroyed()) extWin.webContents.send("chrome.management.onUninstalled", id);
    return extList();
  }

  /** Load an unpacked extension dir into the default session + every per-project session,
   *  track it, and persist it. Encapsulates the cockpit's devloop:extLoadUnpacked flow. */
  async function loadUnpacked(dir: string) {
    const ext = await extSession().extensions.loadExtension(dir, { allowFileAccess: true });
    await loadExtIntoAll(dir); // also load into the other per-project sessions (#27)
    unpackedById.set(ext.id, dir);
    setUnpackedExtensions([...getUnpackedExtensions(), dir]);
    return extList();
  }

  async function initExtensions(): Promise<void> {
    await prepareSession(DEFAULT_PARTITION); // the default/Web Store session, set up before panes navigate
  }

  async function setupExtensionsFor(ses: ReturnType<typeof session.fromPartition>): Promise<void> {
    // Enable the real Chrome Web Store inside this session: this intercepts
    // the store's "Add to Chrome" button and installs into EXT_DIR. It registers
    // its own preload (chrome-web-store.preload.js, copied beside main.cjs by the
    // build) into this session. loadExtensions:false — we load persisted ones below.
    try {
      // modulePath → the lib loads its preload from `<BASE>/dist/chrome-web-store.preload.js`
      // (build.ts copies it there). Without it, the bundled lib resolves a non-existent
      // source path and every pane logs "Unable to load preload script".
      await installChromeWebStore({
        session: ses,
        extensionsPath: EXT_DIR,
        loadExtensions: false,
        allowUnpackedExtensions: true,
        modulePath: BASE,
      });
    } catch (e) {
      log(`extensions: web store setup failed: ${e}`);
    }
    // Surface store installs (Add to Chrome) to the renderer so the list stays live.
    ses.extensions.on("extension-loaded", () => getShellWin()?.webContents.send("devloop:extChanged"));
    ses.extensions.on("extension-unloaded", () => getShellWin()?.webContents.send("devloop:extChanged"));
    try {
      await loadAllExtensions(ses, EXT_DIR, { allowUnpacked: true }); // store extensions persisted under EXT_DIR
    } catch (e) {
      log(`extensions: store load failed: ${e}`);
    }
    for (const dir of getUnpackedExtensions()) {
      // Self-heal: a tracked unpacked dir that no longer exists (deleted, or stale
      // test state) gets pruned from the registry instead of failing every boot.
      if (!existsSync(join(dir, "manifest.json"))) {
        setUnpackedExtensions(getUnpackedExtensions().filter((p) => p !== dir));
        log(`extensions: pruned missing unpacked extension (${dir})`);
        continue;
      }
      try {
        const ext = await ses.extensions.loadExtension(dir, { allowFileAccess: true });
        unpackedById.set(ext.id, dir);
      } catch (e) {
        log(`extensions: unpacked reload failed (${dir}): ${e}`);
      }
    }
    // Unload extensions the user toggled off (loadAllExtensions loaded everything).
    for (const id of getDisabledExtensions()) {
      try {
        ses.extensions.removeExtension(id);
      } catch {
        /* not loaded */
      }
    }
  }

  return {
    extSession,
    openExtensionsWindow,
    extList,
    prepareSession,
    loadExtIntoAll,
    doExtInstall,
    doExtSetEnabled,
    doExtRemove,
    initExtensions,
    loadUnpacked,
  };
}
