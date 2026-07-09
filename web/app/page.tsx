import { Architecture } from "@/components/Architecture";
import { Faq } from "@/components/Faq";
import { Logo } from "@/components/Logo";

const RELEASES = "https://github.com/vincentvella/devloop/releases/latest";
const REPO = "https://github.com/vincentvella/devloop";
const MCPORTER = `${REPO}#when-mcp-is-blocked-enterprise-sandbox--drive-devloop-via-mcporter`;

const agentRules = `For browser or Expo / React Native feature work, use **devloop**:
- dev_start, then browser_navigate (or native_open for iOS/Android).
- After a change, reproduce it with \`repro\` and read the result —
  never claim a fix works without exercising it in the running app.
- browser_snapshot for clickable element refs; \`diagnose\` +
  get_logs_around to line up a console error with the matching
  server stack trace from the same moment.
- Done = verified live in devloop: no console/page errors, the
  expected network calls succeeded, the UI reflects the change.
- Setup stays yours: devloop names the missing toolchain + the fix
  command — it diagnoses, never installs. Run it, then rebuild.`;

const cards = [
  {
    h: "One timeline",
    p: "Server stdout/stderr and browser console/network/page-errors share one clock — correlate cause and effect across the stack.",
  },
  {
    h: "Web and native",
    p: "Drive a browser, or an Expo/React Native app on the iOS simulator or an Android emulator — live device in the pane, native logs + RN network on the same timeline, snapshot/tap via idb/adb.",
  },
  {
    h: "repro",
    p: "Run an action sequence (navigate / click / type / eval), wait for network idle, and get everything that happened on both sides.",
  },
  {
    h: "Per-app scoping",
    p: "Run several projects at once; query logs by app name, not just the active pane. Each project gets isolated browser storage.",
  },
  {
    h: "Shared daemon",
    p: "Run one devloop-mcp daemon and many agents/sessions share it over HTTP/SSE — one browser, one dev server, one timeline.",
  },
  {
    h: "Agent-drivable",
    p: "Headless stdio for Claude Code, MCP-over-HTTP for the cockpit + daemon, or call the tools as plain shell commands via mcporter when MCP is sandboxed.",
  },
];

export default function Home() {
  return (
    <>
      <header>
        <Logo />
        <h1>Devloop</h1>
        <p className="tag">
          Browser control + dev-server logs on <strong>one correlated timeline</strong> — so a
          browser console error and the backend stack trace from the same moment sit side by side.
          For AI agents and humans.
        </p>
        <div className="cta">
          <a className="btn primary" href={RELEASES}>
            Download the app
          </a>
          <a className="btn" href={REPO}>
            GitHub
          </a>
          <a className="btn" href="https://www.npmjs.com/package/devloop-mcp">
            npm
          </a>
        </div>
      </header>

      <section>
        <h2>Watch it work</h2>
        {/* biome-ignore lint/a11y/useMediaCaption: silent product demo loop */}
        <video
          className="demo"
          autoPlay
          loop
          muted
          playsInline
          poster="/demo-poster.png"
          width={1280}
          height={720}
          aria-label="Devloop — browser and dev-server logs converging on one correlated timeline"
        >
          <source src="/demo.webm" type="video/webm" />
          <source src="/demo.mp4" type="video/mp4" />
        </video>
      </section>

      <section>
        <h2>Screenshots</h2>
        <a href="/shots/cockpit.png">
          {/* biome-ignore lint/performance/noImgElement: static marketing screenshot */}
          <img
            className="shot-hero"
            src="/shots/cockpit.png"
            alt="Devloop cockpit: a browser pane beside a unified, filterable timeline of correlated server and browser logs"
            loading="lazy"
          />
        </a>
        <div className="shots">
          <a href="/shots/repro.png">
            {/* biome-ignore lint/performance/noImgElement: static marketing screenshot */}
            <img
              src="/shots/repro.png"
              alt="A Devloop repro result rendered inline on the timeline"
              loading="lazy"
            />
          </a>
          <a href="/shots/multipane.png">
            {/* biome-ignore lint/performance/noImgElement: static marketing screenshot */}
            <img
              src="/shots/multipane.png"
              alt="Devloop running multiple browser panes, each with its own dev server"
              loading="lazy"
            />
          </a>
        </div>
      </section>

      <section>
        <h2>Use it with Claude (MCP)</h2>
        <pre>
          <code>claude mcp add devloop --scope user -- npx -y devloop-mcp</code>
        </pre>
        <p className="tag" style={{ fontSize: 14 }}>
          Then, in any project: <em>“dev_start and repro a navigate to /projects.”</em> It starts
          your dev server, drives the browser, and returns a correlated slice of both sides. Need one
          instance shared across agents? <code>devloop-mcp daemon</code>. MCP blocked by an
          enterprise sandbox? Drive the tools as shell commands — see the{" "}
          <a href={MCPORTER}>mcporter guide</a>.
        </p>
      </section>

      <section>
        <h2>Make your agent reach for it</h2>
        <p className="tag" style={{ fontSize: 14, marginBottom: 14 }}>
          Drop this in your <code>CLAUDE.md</code> (or any agent's rules file) so it drives features
          through Devloop and <strong>verifies them live</strong> — instead of guessing from the
          code:
        </p>
        <pre>
          <code>{agentRules}</code>
        </pre>
        <p className="tag" style={{ fontSize: 13 }}>
          The full copy-paste block is in the{" "}
          <a href={`${REPO}#use-it-from-your-coding-agent`}>README</a>.
        </p>
      </section>

      <section>
        <h2>Or run the cockpit</h2>
        <p className="tag" style={{ fontSize: 14, marginBottom: 14 }}>
          A desktop app: tabbed browser panes (and Expo iOS/Android targets) beside a unified,
          filterable timeline, a repro builder, an element picker, and pop-out browser windows. Grab
          your platform:
        </p>
        <div className="dl">
          <a href={RELEASES}>macOS&nbsp;.dmg</a>
          <a href={RELEASES}>Windows&nbsp;.exe</a>
          <a href={RELEASES}>Linux&nbsp;.AppImage</a>
          <a href={RELEASES}>Linux&nbsp;.deb</a>
        </div>
      </section>

      <section>
        <h2>What it does</h2>
        <div className="grid">
          {cards.map((c) => (
            <div className="card" key={c.h}>
              <h3>{c.h}</h3>
              <p>{c.p}</p>
            </div>
          ))}
        </div>
      </section>

      <Architecture />

      <Faq />

      <footer>
        MIT © Vincent Vella · <a href={REPO}>vincentvella/devloop</a>
      </footer>
    </>
  );
}
