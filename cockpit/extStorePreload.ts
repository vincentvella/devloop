/**
 * Injected into the embedded Chrome Web Store window. Google greys its native
 * "Add to Chrome" button for non-Chrome browsers (and the detection can't be
 * reliably spoofed), so — like ungoogled-chromium's chromium-web-store extension —
 * we inject our OWN button that installs via Devloop's direct CRX download
 * (the devloop:extInstall IPC), instead of fighting the page.
 *
 * The preload runs in an isolated context but shares the page DOM, so it can add
 * the button and wire its click straight to ipcRenderer — no main-world bridge.
 */
import { ipcRenderer } from "electron";
import { webStoreDetailId } from "../src/extensions.ts";

const BTN_ID = "__devloop_install_btn";
const PURPLE = "#8957e5";

function style(btn: HTMLButtonElement): void {
  Object.assign(btn.style, {
    position: "fixed",
    top: "14px",
    right: "16px",
    zIndex: "2147483647",
    padding: "10px 16px",
    font: "600 13px system-ui, -apple-system, sans-serif",
    color: "#fff",
    background: PURPLE,
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(0,0,0,.35)",
  });
}

function ensureButton(): void {
  const id = webStoreDetailId(location.href);
  const existing = document.getElementById(BTN_ID) as HTMLButtonElement | null;
  if (!id || !document.body) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.dataset.extId = id; // keep it pointed at the current detail page
    return;
  }
  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.dataset.extId = id;
  btn.textContent = "+ Add to Devloop";
  style(btn);
  btn.addEventListener("click", async () => {
    const extId = btn.dataset.extId;
    if (!extId) return;
    btn.disabled = true;
    btn.textContent = "Installing…";
    try {
      await ipcRenderer.invoke("devloop:extInstall", extId);
      btn.textContent = "✓ Added to Devloop";
      btn.style.background = "#238636";
    } catch (e) {
      btn.textContent = `Install failed — ${(e as Error)?.message?.split(":").pop()?.trim() ?? "error"}`;
      btn.style.background = "#da3633";
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = "+ Add to Devloop";
        btn.style.background = PURPLE;
      }, 3500);
    }
  });
  document.body.appendChild(btn);
}

// The Web Store is a SPA — the detail page + URL change without a full reload, and
// it can re-render the body out from under us. Re-checking on an interval keeps the
// button in sync with the current page (and re-adds it if the SPA removed it).
function start(): void {
  ensureButton();
  setInterval(ensureButton, 1000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
