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

// Dispatch hover events to the element (fires JS-driven menus; works offscreen/headless).
export const hoverJs = (selector: string) =>
  `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();` +
  `const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};` +
  `for(const t of ['pointerover','pointerenter','mouseover','mouseenter','mousemove'])e.dispatchEvent(new MouseEvent(t,o));return true;})()`;
