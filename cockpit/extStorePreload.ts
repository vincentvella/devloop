/**
 * Injected into the embedded Chrome Web Store window. Google greys its native
 * "Add to Chrome" button for non-Chrome browsers (and the detection can't be
 * reliably spoofed), so — like ungoogled-chromium's chromium-web-store extension —
 * we install via Devloop's direct CRX download (the devloop:extInstall IPC) instead
 * of fighting the page.
 *
 * Rather than a floating button, we clone the native "Add to Chrome" button (so it
 * inherits Google's exact size/shape/position), drop it in its place, and re-enable
 * it as "+ Add to Devloop". We also dismiss Google's recurring "Switch to Chrome?"
 * nag dialog. The preload runs in an isolated context but shares the page DOM, so it
 * can do this and wire the click straight to ipcRenderer — no main-world bridge.
 */
import { ipcRenderer } from "electron";
import { webStoreDetailId } from "../src/extensions.ts";

const BTN_ID = "__devloop_install_btn";
const PURPLE = "#8957e5"; // not installed → "Add"
const SLATE = "#5f6368"; // installed → "Remove"

function findNativeAddButton(): HTMLButtonElement | null {
  for (const b of document.querySelectorAll("button")) {
    if (b.id !== BTN_ID && /^\s*add to chrome\s*$/i.test(b.textContent || "")) return b as HTMLButtonElement;
  }
  return null;
}

async function isInstalled(id: string): Promise<boolean> {
  try {
    const list = (await ipcRenderer.invoke("devloop:extList")) as Array<{ id: string }>;
    return Array.isArray(list) && list.some((e) => e.id === id);
  } catch {
    return false;
  }
}

/** Reflect the real install state (Add ↔ Remove), like Chrome's own button. */
function setMode(btn: HTMLButtonElement, mode: "add" | "remove"): void {
  if (btn.dataset.busy) return;
  btn.dataset.mode = mode;
  btn.textContent = mode === "remove" ? "Remove from Devloop" : "+ Add to Devloop";
  btn.style.background = mode === "remove" ? SLATE : PURPLE;
}

async function refreshMode(btn: HTMLButtonElement, id: string): Promise<void> {
  if (btn.dataset.busy) return;
  setMode(btn, (await isInstalled(id)) ? "remove" : "add");
}

function wire(btn: HTMLButtonElement): void {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const extId = btn.dataset.extId;
    if (!extId || btn.dataset.busy) return;
    const removing = btn.dataset.mode === "remove";
    btn.dataset.busy = "1";
    btn.textContent = removing ? "Removing…" : "Installing…";
    try {
      await ipcRenderer.invoke(removing ? "devloop:extRemove" : "devloop:extInstall", extId);
      delete btn.dataset.busy;
      setMode(btn, removing ? "add" : "remove");
    } catch (err) {
      btn.textContent = `${removing ? "Remove" : "Install"} failed — ${(err as Error)?.message?.split(":").pop()?.trim() ?? "error"}`;
      btn.style.background = "#da3633";
      delete btn.dataset.busy;
      setTimeout(() => void refreshMode(btn, extId), 3500);
    }
  });
}

/** Our own filled-pill button (fully self-styled — Google's obfuscated button
 *  classes don't lay out as a bare clone, and the label markup is nested). Sized to
 *  sit naturally in the header action slot where the native button was. */
function buildButton(id: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.dataset.extId = id;
  btn.textContent = "+ Add to Devloop"; // refined by refreshMode once install state is known
  Object.assign(btn.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: "36px",
    padding: "0 22px",
    margin: "0",
    font: "500 14px 'Google Sans', Roboto, system-ui, sans-serif",
    color: "#fff",
    background: PURPLE,
    border: "none",
    borderRadius: "100px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxShadow: "0 1px 3px rgba(0,0,0,.25)",
  });
  wire(btn);
  return btn;
}

function dismissSwitchNag(): void {
  // The "Switch to Chrome?" popup dialog.
  for (const d of document.querySelectorAll('[role="dialog"]')) {
    if (/switch to chrome/i.test(d.textContent || "")) d.remove();
  }
  // The "Switch to Chrome to install extensions and themes" banner bar: from the
  // text leaf, walk up to the wide-but-short row that is the banner, and hide it.
  const hit = [...document.querySelectorAll("*")].find(
    (e) => e.children.length === 0 && /switch to chrome to install/i.test(e.textContent || ""),
  );
  if (hit) {
    const minW = document.documentElement.clientWidth * 0.6;
    let bar: HTMLElement | null = hit as HTMLElement;
    for (let i = 0; i < 6 && bar; i++) {
      const r = bar.getBoundingClientRect();
      if (r.width >= minW && r.height <= 80) {
        bar.style.display = "none";
        break;
      }
      bar = bar.parentElement;
    }
  }
}

function ensure(): void {
  dismissSwitchNag();
  const id = webStoreDetailId(location.href);
  let ours = document.getElementById(BTN_ID) as HTMLButtonElement | null;
  if (!id) {
    ours?.remove();
    return;
  }
  const native = findNativeAddButton();
  if (native) native.style.display = "none"; // take its place
  if (!ours) {
    ours = buildButton(id);
    if (native?.parentElement) native.insertAdjacentElement("afterend", ours);
    else {
      // Fallback: the page structure changed — float it so it's still reachable.
      Object.assign(ours.style, { position: "fixed", top: "14px", right: "16px", zIndex: "2147483647" });
      document.body.appendChild(ours);
    }
  } else if (native && ours.previousElementSibling !== native) {
    native.insertAdjacentElement("afterend", ours);
  }
  ours.dataset.extId = id;
  // Reflect the install state (Add ↔ Remove) when first shown or after navigating to
  // another extension. Cleared on extChanged so installs/removes elsewhere refresh it.
  if (!ours.dataset.busy && ours.dataset.checkedId !== id) {
    ours.dataset.checkedId = id;
    void refreshMode(ours, id);
  }
}

ipcRenderer.on("devloop:extChanged", () => {
  const b = document.getElementById(BTN_ID) as HTMLButtonElement | null;
  if (b) delete b.dataset.checkedId; // force a re-check on the next tick
});

// The Web Store is a SPA — the detail page + URL change without a full reload, the
// native button re-renders, and the nag dialog re-appears. Re-checking on an interval
// keeps our button in place and the nag dismissed.
function start(): void {
  ensure();
  setInterval(ensure, 800);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
