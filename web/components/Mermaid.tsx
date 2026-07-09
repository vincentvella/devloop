"use client";

import { useEffect, useRef } from "react";

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose", // our own content; allow the <b>/<i>/<br> labels
        theme: "dark",
        themeVariables: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          darkMode: true,
        },
      });
      const { svg } = await mermaid.render("arch-diagram", chart);
      if (!cancelled && ref.current) ref.current.innerHTML = svg;
    })();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  return <pre className="mermaid" ref={ref} />;
}
