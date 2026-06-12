/**
 * A compact, agent-friendly page snapshot: the page's interactive + landmark
 * elements with role, accessible name, and a CSS selector (`ref`) that the
 * existing browser_click / browser_type tools can act on. Built by evaluating
 * one self-contained expression in the page, so both substrates share it.
 */

export interface SnapNode {
  /** CSS selector usable with browser_click / browser_type. */
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  state?: string; // e.g. "disabled", "checked", "expanded=true"
  level?: number; // heading level (h1–h6)
}

export interface PageSnapshot {
  url: string;
  title: string;
  nodes: SnapNode[];
  truncated?: boolean;
}

/** Expression (IIFE) returning a PageSnapshot. Runs in the page main world. */
export const SNAPSHOT_JS = String.raw`(() => {
  const MAX = 250, NAMELEN = 120;
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
  const vis = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const tid = el.getAttribute('data-testid'); if (tid) return '[data-testid="' + tid.replace(/"/g, '\\"') + '"]';
    const nm = el.getAttribute('name'); if (nm && /^(input|select|textarea|button)$/i.test(el.tagName)) return el.tagName.toLowerCase() + '[name="' + nm.replace(/"/g, '\\"') + '"]';
    const parts = []; let node = el, depth = 0;
    while (node && node.nodeType === 1 && node.tagName !== 'BODY' && depth < 6) {
      let sel = node.tagName.toLowerCase();
      const p = node.parentElement;
      if (p) { const sibs = [...p.children].filter((c) => c.tagName === node.tagName); if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'; }
      parts.unshift(sel); node = p; depth++;
    }
    return parts.join(' > ');
  };
  const name = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? txt(e) : ''; }).join(' ').trim(); if (t) return t; }
    if (el.id) { const lab = document.querySelector('label[for="' + esc(el.id) + '"]'); if (lab) return txt(lab); }
    const wrap = el.closest && el.closest('label'); if (wrap && /^(input|select|textarea)$/i.test(el.tagName)) return txt(wrap);
    return el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || txt(el) || (el.value || '');
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'input') {
      const it = (el.getAttribute('type') || 'text').toLowerCase();
      return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', search: 'searchbox', range: 'slider' })[it] || 'textbox';
    }
    return null;
  };
  const SEL = 'a[href],button,input,select,textarea,[role],[onclick],[tabindex],h1,h2,h3,h4,h5,h6,summary';
  const out = []; let truncated = false;
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= MAX) { truncated = true; break; }
    if (!vis(el)) continue;
    const role = roleOf(el); if (!role || role === 'generic') continue;
    const node = { ref: cssPath(el), role, name: name(el).slice(0, NAMELEN), tag: el.tagName.toLowerCase() };
    if (/^h[1-6]$/.test(node.tag)) node.level = +node.tag[1];
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.value != null && /^(input|textarea|select)$/i.test(el.tagName) && type !== 'password') node.value = String(el.value).slice(0, NAMELEN);
    const st = []; if (el.disabled) st.push('disabled'); if (el.checked) st.push('checked');
    const ae = el.getAttribute('aria-expanded'); if (ae) st.push('expanded=' + ae);
    if (st.length) node.state = st.join(',');
    out.push(node);
  }
  return { url: location.href, title: document.title, nodes: out, truncated };
})()`;
