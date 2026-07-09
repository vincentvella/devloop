const faqs = [
  {
    q: "How do I see browser console errors and backend logs together?",
    a: "Devloop timestamps your dev server's stdout/stderr and the browser's console, network, and page errors into one buffer, so a console error and the backend stack trace from the same moment line up on a single correlated timeline.",
  },
  {
    q: "Does it work with Claude Code and MCP?",
    a: "Yes. Devloop is an MCP server. Add it with 'claude mcp add devloop --scope user -- npx -y devloop-mcp' and Claude Code can drive your browser and dev server and read both sides of the timeline.",
  },
  {
    q: "Can it drive a native iOS or Android app?",
    a: "Yes — it controls an Expo / React Native app on the iOS simulator or an Android emulator, with native logs and RN network on the same timeline and snapshot/tap via idb/adb.",
  },
  {
    q: "How is this different from Puppeteer or browser devtools?",
    a: "Those show only the browser side. Devloop correlates the browser with your dev-server logs (and native logs) on one clock, and exposes it to AI agents over MCP — so you debug cause and effect across the whole stack, not just the front end.",
  },
  {
    q: "What if MCP is blocked by an enterprise sandbox?",
    a: "Drive the same tools as plain shell commands via mcporter — see the mcporter guide in the GitHub README.",
  },
  {
    q: "Can multiple agents share one instance?",
    a: "Run 'devloop-mcp daemon' and many agents or sessions share it over HTTP/SSE — one browser, one dev server, one timeline.",
  },
];

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

export function Faq() {
  return (
    <section>
      <h2>FAQ</h2>
      <div className="grid">
        {faqs.map((f) => (
          <div className="card" key={f.q}>
            <h3>{f.q}</h3>
            <p>{f.a}</p>
          </div>
        ))}
      </div>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
    </section>
  );
}
