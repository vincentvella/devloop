/**
 * A tiny deterministic web app for the behavioral tests (smoke + selftest).
 * Has a real `dev` script, so `dev_start` auto-detects + spawns it and the
 * cockpit auto-navigates to the URL it prints. Routes:
 *   /            — page with known elements (h1, labeled input, select, buttons, link)
 *   /api/boom    — 500
 *   /api/slow    — delayed 200 (?ms=)
 *   /about       — second page (for back/forward)
 * Pure Bun, no deps.
 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Devloop Fixture</title></head>
<body>
  <h1>Devloop Fixture</h1>
  <label for="name">Your name</label><input id="name">
  <select id="fruit"><option value="apple">Apple</option><option value="pear">Pear</option></select>
  <button id="go" aria-label="Submit form">Go</button>
  <button id="boom" onclick="fetch('/api/boom').catch(()=>{})">Trigger 500</button>
  <a id="about" href="/about">About</a>
  <script>console.log('fixture-loaded')</script>
</body></html>`;

// A minified, source-mapped bundle that throws on load — for the source-map test.
const smBundle = await Bun.build({ entrypoints: [import.meta.dir + "/sm-src.ts"], target: "browser", sourcemap: "inline", minify: true });
const smJs = smBundle.success ? await smBundle.outputs[0]!.text() : "throw new Error('build failed')";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/boom") return Response.json({ error: "intentional 500" }, { status: 500 });
    if (url.pathname === "/app.js") return new Response(smJs, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/sm") return new Response('<!doctype html><title>sm</title><script src="/app.js"></script>', { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/slow") {
      await new Promise((r) => setTimeout(r, Number(url.searchParams.get("ms") ?? 300)));
      return new Response("slow ok");
    }
    if (url.pathname === "/about") return new Response("<!doctype html><title>About</title><h1>About</h1>", { headers: { "content-type": "text/html" } });
    return new Response(HTML, { headers: { "content-type": "text/html" } });
  },
});

// The cockpit's auto-navigate watches server logs for a localhost URL.
console.log(`Local: http://localhost:${server.port}`);
console.log("fixture ready");
