/**
 * Page-action JS snippets shared by both substrates (run via the controller's
 * evaluate / executeJavaScript). Each is a self-contained expression returning
 * a boolean "found" where relevant.
 */

export const scrollJs = (o: { selector?: string; x?: number; y?: number }) =>
  o.selector
    ? `(()=>{const e=document.querySelector(${JSON.stringify(o.selector)});if(e)e.scrollIntoView({block:'center',inline:'center'});return !!e;})()`
    : `(()=>{window.scrollTo(${Number(o.x) || 0},${Number(o.y) || 0});return true;})()`;

export const selectJs = (selector: string, value: string) =>
  `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;` +
  `e.value=${JSON.stringify(value)};` +
  `e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;

export const focusJs = (selector: string) =>
  `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return true;})()`;

export const centerJs = (selector: string) =>
  `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`;

// Interactive element picker: overlays a highlight, resolves a stable selector on
// click (Escape cancels → null). Returns a Promise, so executeJavaScript awaits it.
export const PICKER_JS = String.raw`(() => new Promise((resolve) => {
  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
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
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #d2a8ff;background:rgba(210,168,255,0.15);border-radius:3px';
  document.documentElement.appendChild(ov);
  let cur = null;
  const move = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); if (!el || el === ov) return; cur = el; const r = el.getBoundingClientRect(); ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px'; ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px'; };
  const done = (sel) => { document.removeEventListener('pointermove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); ov.remove(); resolve(sel); };
  const click = (e) => { e.preventDefault(); e.stopPropagation(); const el = cur || document.elementFromPoint(e.clientX, e.clientY); done(el && el !== ov ? cssPath(el) : null); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
}))()`;

// Dispatch hover events to the element (fires JS-driven menus; works offscreen/headless).
export const hoverJs = (selector: string) =>
  `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();` +
  `const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};` +
  `for(const t of ['pointerover','pointerenter','mouseover','mouseenter','mousemove'])e.dispatchEvent(new MouseEvent(t,o));return true;})()`;
