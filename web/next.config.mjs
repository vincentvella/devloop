import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app is a Bun workspace member of the devloop-mcp repo; deps hoist to the
  // repo root, so trace from there (also silences Next's workspace-root inference).
  outputFileTracingRoot: join(__dirname, ".."),
};

export default nextConfig;
