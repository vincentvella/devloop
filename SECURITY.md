# Security Policy

## Supported Versions

devloop is an early-stage `0.x` project. Security fixes are only provided for
the latest `0.6.x` release line. Older minor versions are not maintained — if
you are on an earlier release, please upgrade to the latest `0.6.x`.

| Version | Supported          |
| ------- | ------------------ |
| 0.6.x   | :white_check_mark: |
| < 0.6   | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities **privately**. Do not open a public
GitHub issue for security problems.

The preferred channel is GitHub's private vulnerability reporting. Go to the
repository's **Security** tab and click **"Report a vulnerability"**, or use
this direct link:

https://github.com/vincentvella/devloop/security/advisories/new

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- Affected version(s) and your environment, if relevant

devloop is solo-maintained, so responses are best-effort rather than a formal
SLA. I aim to acknowledge new reports within a few days, and I will keep you
updated as I investigate and work on a fix. Thanks for helping keep the project
and its users safe.

## Scope

devloop is a **local developer tool**. It runs entirely on the developer's own
machine — it launches Puppeteer/Chrome and an Electron "cockpit" and captures
your app's logs and network traffic locally. There is no hosted backend
service operated by the project.

The relevant security surface is therefore:

- The locally-running MCP server, headless daemon, and Electron cockpit
- The `devloop-mcp` npm package and its supply chain

Issues in third-party dependencies should generally be reported upstream to the
respective project, though you are welcome to flag them here if they materially
affect devloop.
