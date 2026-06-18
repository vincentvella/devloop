// Minimal dev server for the cockpit GUI tests. It exercises the unified timeline:
// the served page emits a console.log, a successful fetch, and a failing (500) fetch,
// and exposes a button that logs + fetches on click (for repro/click tests).
//
// It binds to an ephemeral port and prints `http://localhost:<port>` so the cockpit's
// auto-navigate picks it up exactly like a real dev server (Vite/Next/Metro).
import { createServer } from "node:http";

const PAGE = `<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width"><title>Devloop Fixture</title></head>
  <body style="font:14px system-ui;margin:24px">
    <h1 data-testid="title">Devloop fixture app</h1>
    <button id="ping" data-testid="ping">ping</button>
    <p id="status" data-testid="status">idle</p>
    <script>
      console.log("fixture: page loaded");
      fetch("/api/ok").then((r) => r.json()).then((d) => console.log("fixture: ok value", d.v));
      fetch("/api/fail").then((r) => console.log("fixture: fail status", r.status)).catch(() => {});
      document.getElementById("ping").addEventListener("click", () => {
        console.log("fixture: ping clicked");
        document.getElementById("status").textContent = "pinged";
        fetch("/api/ping");
      });
    </script>
  </body>
</html>`;

const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/api/ok") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ v: 42 }));
  }
  if (url === "/api/fail") {
    res.statusCode = 500;
    return res.end("intentional failure");
  }
  if (url === "/api/ping") {
    return res.end("pong");
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(PAGE);
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // The cockpit watches dev-server stdout for this and auto-navigates the pane.
  console.log(`fixture dev server: http://localhost:${port}`);
});
