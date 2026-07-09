import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://devloop.build"),
  title: "Devloop — browser + dev-server logs on one correlated timeline (MCP)",
  description:
    "Devloop drives a browser — or a native iOS/Android Expo app — and your dev server, putting both on one correlated timeline so a browser console error and the backend stack trace from the same moment sit side by side. An MCP server with a headless (stdio) mode, a shared HTTP/SSE daemon, and an Electron cockpit, built for Claude Code and AI agents.",
  keywords: [
    "MCP server",
    "model context protocol",
    "browser automation",
    "dev server logs",
    "correlated timeline",
    "Claude Code",
    "AI agents",
    "Puppeteer",
    "Expo",
    "React Native",
    "observability",
    "repro",
  ],
  authors: [{ name: "Vincent Vella" }],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Devloop",
    url: "https://devloop.build/",
    title: "Devloop — browser + dev-server logs on one timeline",
    description:
      "Browser + native (iOS/Android) control + dev-server logs on one correlated timeline — an MCP server for Claude Code, AI agents, and humans.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Devloop — browser and dev-server logs on one correlated timeline",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Devloop — browser + dev-server logs on one timeline",
    description:
      "Browser + native control + dev-server logs on one correlated timeline — an MCP server for Claude Code, AI agents, and humans.",
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0d1117",
};

const softwareLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Devloop",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Windows, Linux",
  description:
    "An MCP server that drives a browser (or a native iOS/Android Expo app) and your dev server, putting both on one correlated timeline. Headless stdio for Claude Code and AI agents, a shared HTTP/SSE daemon, and an Electron cockpit.",
  url: "https://devloop.build/",
  downloadUrl: "https://github.com/vincentvella/devloop/releases/latest",
  softwareHelp: "https://github.com/vincentvella/devloop#readme",
  license: "https://github.com/vincentvella/devloop/blob/main/LICENSE",
  author: { "@type": "Person", name: "Vincent Vella" },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

const videoLd = {
  "@context": "https://schema.org",
  "@type": "VideoObject",
  name: "Devloop — browser + dev-server logs on one correlated timeline",
  description:
    "How Devloop puts a browser console error and the backend stack trace from the same moment on one correlated timeline.",
  thumbnailUrl: "https://devloop.build/demo-poster.png",
  contentUrl: "https://devloop.build/demo.mp4",
  uploadDate: "2026-06-25",
  duration: "PT14S",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareLd) }}
        />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
          dangerouslySetInnerHTML={{ __html: JSON.stringify(videoLd) }}
        />
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
