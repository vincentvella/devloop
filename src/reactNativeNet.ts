/**
 * React Native network capture (#17). Hermes' inspector doesn't implement the CDP
 * `Network.*` domain, so we can't observe requests the way we do for web panes. RN
 * routes fetch + XHR through its global `XMLHttpRequest`, so we inject a prototype
 * patch (over the CDP Runtime.evaluate channel we already own) that times each
 * request and reports it back as a console marker — which the controller turns into
 * the same `browser:network` timeline entry + `NetDetail` shape the web side emits
 * (so HAR export, diagnose, and the network chip all just work).
 *
 * Pure: the marker prefix, the injected snippet (a constant string), and the parser.
 * The live injection is exercised by scripts/rn-harness.ts against a real app.
 */
import type { NetDetail } from "./har.ts";

/** Console-log prefix the injected interceptor uses to ferry events back over CDP. */
export const NET_MARKER = "__DEVLOOP_NET__";

const BODY_CAP = 4000;

/**
 * IIFE injected into the Hermes JS context after each (re)attach. Idempotent within a
 * context (a reload resets the global, so the controller re-injects). Patches
 * XMLHttpRequest.prototype open/setRequestHeader/send, then on `loadend` emits one
 * NetDetail-shaped event via console.log(NET_MARKER + json). Self-contained (no
 * requires) and defensive — any throw is swallowed so it never breaks the app.
 */
export const NET_INTERCEPTOR_JS = `(function(){
  if (globalThis.__DEVLOOP_NET_HOOKED__) return 'already';
  var XHR = globalThis.XMLHttpRequest;
  if (!XHR || !XHR.prototype) return 'no-xhr';
  var open = XHR.prototype.open, send = XHR.prototype.send, setRH = XHR.prototype.setRequestHeader;
  var cap = ${BODY_CAP};
  function headersToObj(raw){ var o={}; if(!raw) return o; raw.trim().split(/[\\r\\n]+/).forEach(function(l){ var i=l.indexOf(':'); if(i>0) o[l.slice(0,i).trim()]=l.slice(i+1).trim(); }); return o; }
  XHR.prototype.open = function(method,url){ try{ this.__dl={method:method,url:url,reqHeaders:{},start:Date.now()}; }catch(e){} return open.apply(this,arguments); };
  XHR.prototype.setRequestHeader = function(h,v){ try{ if(this.__dl) this.__dl.reqHeaders[h]=v; }catch(e){} return setRH.apply(this,arguments); };
  XHR.prototype.send = function(body){
    var self=this, d=self.__dl;
    if(d){
      if(typeof body==='string') d.reqBody=body.slice(0,cap);
      self.addEventListener('loadend', function(){
        try{
          var ev={kind:'network', method:d.method, url:(self.responseURL||d.url), status:self.status, durationMs:(Date.now()-d.start), requestHeaders:d.reqHeaders, resourceType:'fetch'};
          if(d.reqBody) ev.requestBody=d.reqBody;
          var rh = self.getAllResponseHeaders ? self.getAllResponseHeaders() : '';
          var ro = headersToObj(rh); if(Object.keys(ro).length) ev.responseHeaders=ro;
          if(ro['content-type']||ro['Content-Type']) ev.mimeType=(ro['content-type']||ro['Content-Type']);
          if(self.status===0) ev.failure='network error (request failed / blocked / timed out)';
          try{ var rt=self.responseType; if((rt===''||rt==='text')&&typeof self.responseText==='string') ev.responseBody=self.responseText.slice(0,cap); }catch(e){}
          console.log('${NET_MARKER}'+JSON.stringify(ev));
        }catch(e){}
      });
    }
    return send.apply(this,arguments);
  };
  globalThis.__DEVLOOP_NET_HOOKED__=true;
  return 'hooked';
})()`;

/** A captured network event → a timeline line + NetDetail, or null if `text` isn't a marker. */
export function parseNetMarker(text: string): { line: string; detail: NetDetail } | null {
  if (!text.startsWith(NET_MARKER)) return null;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(text.slice(NET_MARKER.length));
  } catch {
    return null;
  }
  if (!ev || typeof ev.url !== "string") return null;
  const detail: NetDetail = {
    kind: "network",
    url: ev.url,
    method: typeof ev.method === "string" ? ev.method : undefined,
    status: typeof ev.status === "number" ? ev.status : undefined,
    resourceType: typeof ev.resourceType === "string" ? ev.resourceType : "fetch",
    mimeType: typeof ev.mimeType === "string" ? ev.mimeType : undefined,
    durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
    requestHeaders: isStrMap(ev.requestHeaders) ? ev.requestHeaders : undefined,
    responseHeaders: isStrMap(ev.responseHeaders) ? ev.responseHeaders : undefined,
    requestBody: typeof ev.requestBody === "string" ? ev.requestBody : undefined,
    responseBody: typeof ev.responseBody === "string" ? ev.responseBody : undefined,
    failure: typeof ev.failure === "string" ? ev.failure : undefined,
    startedAt: Date.now(),
  };
  const status = detail.failure ? "FAILED" : (detail.status ?? "");
  const line = `${status} ${detail.method ?? ""} ${detail.url}`.trim();
  return { line, detail };
}

const isStrMap = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v);
