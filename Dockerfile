# Minimal image for MCP introspection (e.g. Glama's listing check).
#
# Devloop is a local-first tool: when a browser/native tool is actually called
# it drives Chrome (Puppeteer) or a simulator on the developer's machine. But
# the MCP server starts and answers introspection (initialize + tools/list)
# over stdio without launching Chrome, so this image needs only Node — no
# Chromium download required.
FROM node:22-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Pinned to match server.json; bump alongside releases.
RUN npm install -g devloop-mcp@0.5.2

# No args => stdio MCP server (the same command `claude mcp add` runs).
ENTRYPOINT ["devloop-mcp"]
