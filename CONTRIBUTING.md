# Contributing to Devloop

Thanks for your interest in Devloop! It's an MCP server + headless daemon + Electron "cockpit" that puts browser and dev-server logs on one correlated timeline for AI coding agents. Contributions of all kinds are welcome — bug fixes, new tools, cockpit features, docs, and tests.

This guide covers how to get set up and what we expect in a pull request. If anything here is unclear or out of date, please [open an issue](https://github.com/vincentvella/devloop/issues) or start a [discussion](https://github.com/vincentvella/devloop/discussions).

## Prerequisites

- **[bun](https://bun.sh)** — Devloop uses bun for everything (install, scripts, tests, builds). **Do not use `npm`/`npx`/`node` to run project scripts** — always `bun` / `bunx`.
- **Node `>=18.20.8`** — the engine the package targets (Electron and some tooling rely on it).
- **macOS / Windows / Linux** for the headless MCP and daemon. The Electron cockpit builds cross-platform; the **embedded iOS simulator** is macOS + Apple Silicon only, and Android targets need the Android SDK platform-tools (`adb`) + a booted emulator. None of that is required to work on the core MCP server, the daemon, or most of the cockpit.

## Getting set up

```sh
git clone https://github.com/vincentvella/devloop.git
cd devloop
bun install            # Puppeteer fetches Chromium on first install
```

Run things locally:

```sh
bun run start          # run the stdio MCP server directly
bun run app            # build + launch the Electron cockpit
```

## Running the tests

Devloop has a layered test harness. Run the suite(s) relevant to your change, and run the full suite before opening a PR.

| Command | What it covers |
| --- | --- |
| `bun test` | Unit tests. |
| `bun run typecheck` | TypeScript across the server, the cockpit renderer, and the GUI tests. |
| `bun run test-smoke.ts` | stdio smoke test — headless Puppeteer: structured args, networkidle, repro sequences, abort. |
| `bun run app:selftest` | Electron cockpit selftest — substrate→buffer, tool layer, MCP-over-HTTP, renderer IPC, registry, multi-pane + pop-out, persistence/restore, teardown (headless, no visible windows). |
| `bun run test:daemon` | Daemon (HTTP/SSE) end-to-end. |
| `bun run test:mcporter` | Driving Devloop's tools via [mcporter](https://mcporter.sh) over the CLI bridge. |
| `bun run test:all` | The gate: `typecheck` + `bun test` + smoke + cockpit selftest. |

There are a few more specialized scripts too — `bun run test:autoconnect` (daemon auto-connect), `bun run tools:audit` (tool-definition quality), and `bun run rn:smoke` (React Native harness) — run them when your change touches those areas.

**Before you push, `bun run test:all` should be green.**

## Test-first convention

Devloop is built **test-first**. New features and bug fixes are expected to come with coverage against the existing harness — a unit test, a case in the smoke test, and/or an assertion in the cockpit selftest, whichever fits the surface you're changing. Adding a tool? Extend the selftest/smoke flow that exercises it. Fixing a bug? Add a test that fails before your fix and passes after. PRs that add behavior without tests will usually be asked to add them.

## Code style

- **TypeScript** throughout (server, cockpit main/preload, React 19 renderer). Keep types honest — `bun run typecheck` must pass.
- **Biome** is the lint/format tool (`@biomejs/biome`). A lint/format check may run in CI, so format your changes before pushing:

  ```sh
  bunx biome check --write .
  ```

- Match the surrounding code. Keep `stdout` reserved for the MCP protocol in stdio mode — human-facing output goes to `stderr`.

## Commit messages

Devloop uses [Conventional Commits](https://www.conventionalcommits.org/). Prefix the type and an optional scope:

```
feat(cockpit): add per-pane throttle picker
fix(daemon): fall back to local instance when the socket is stale
test(smoke): cover repro continueOnError
chore(deps): bump puppeteer to 25.3
docs: clarify daemon auto-connect
```

Common types: `feat`, `fix`, `test`, `chore`, `docs`, `refactor`, `perf`. Common scopes: `cockpit`, `daemon`, `mcp`, `native`, `deps`.

## Pull request process

1. **Fork** the repo and create a branch off `main` (`feat/...`, `fix/...`).
2. Make your change **test-first**, keeping commits in Conventional Commits style.
3. Run `bun run test:all` and `bunx biome check --write .` — everything green and formatted.
4. Update docs (README, this file, tool descriptions) if your change affects behavior or usage.
5. **Open a PR** against `main` and fill out the PR template — summarize the change, note which test suites you ran, and complete the checklist.

A maintainer will review. Thanks for helping make Devloop better!

## Reporting bugs & proposing ideas

- **Bugs** and **feature requests** go through the [issue forms](https://github.com/vincentvella/devloop/issues/new/choose).
- **Open-ended ideas, questions, and show-and-tell** belong in [Discussions](https://github.com/vincentvella/devloop/discussions).
- Please follow the [Code of Conduct](./CODE_OF_CONDUCT.md) in all project spaces.
