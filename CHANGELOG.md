# Changelog

All notable changes to **devloop** (npm `devloop-mcp`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _Nothing yet._

## [0.7.0] - 2026-06-26

### Added

- **In-app crash reporting (cockpit)** — uncaught errors (main process, renderer, or child-process crashes) offer to open a **prefilled GitHub issue** you review and submit under your own account. No telemetry vendor, nothing sent automatically. Plus a **Settings → report a bug** entry for filing one any time.

### Changed

- Adopted **[Biome](https://biomejs.dev)** as the single lint + format gate (`bun run check` / `bun run format`), wired into CI; Tailwind v4 CSS is linted too.
- Dependency bumps: **Electron 42.5**, **Puppeteer 25.2**, **TypeScript 6**, **@modelcontextprotocol/sdk 1.29**, **Remotion 4.0.483**, **playwright-core 1.61.1**, **electron-builder 26.15.3**, cockpit UI (React / Radix / Tailwind / lucide-react), and **serve-sim 0.1.44**. Node engine is now **>=18.20.8**.

### Tooling

- **mcporter toolcall smoke** in CI — exercises the `mcporter call devloop.<tool>` CLI path that sandboxed / enterprise agents use, end-to-end over HTTP.
- Dependency & intake tooling: scoped **Renovate**, a `bun audit` runtime gate, GitHub issue forms, and **MCP Registry auto-publish on release** (GitHub OIDC).

### Docs

- Added **SECURITY**, **CONTRIBUTING**, **CHANGELOG**, **CODE_OF_CONDUCT**, a **pull-request template**, and **CODEOWNERS**; README gains CI / Biome / Conventional-Commits badges and expanded dev docs.

## [0.6.2] - 2026-06-26

### Added

- Typed `defineTool` generator so MCP tools are TDQS-compliant by construction.
- README badge row (npm, Glama A/A/A score, MIT license).

### Changed

- Tool-definition quality pass with a CI lint gate enforcing TDQS standards.

## [0.6.1] - 2026-06-26

### Added

- Full MCP tool parity: browser back/forward/reload, `pane_set_label`, and extension (`ext_*`) tools.
- Shared-mode stdio auto-connect and lifecycle handling for the daemon.
- `glama.json` to claim the Glama listing.
- Cockpit hero screenshot in the README plus an automated real-screenshot gallery on the site.

### Changed

- Selftest now runs a per-step ratchet inside a hermetic profile.

## [0.6.0] - 2026-06-25

### Added

- MCP Registry manifest (`server.json`) and `smithery.yaml` for registry publishing.
- Installable Agent Skill for driving Devloop via mcporter, with the full tool catalog embedded.
- Minimal Docker image for MCP introspection.
- New "d-loop" logo (cyan-to-blue gradient with an amber moment) and plate-less / square avatar variants.
- Remotion hero loop video, screenshot scaffolding, and a refreshed landing page.

### Changed

- SEO overhaul: custom domain `devloop.build`, social/meta tags, structured data, and an FAQ.
- Trimmed the server description to the MCP Registry's 100-character limit.

### Fixed

- Scoped the iOS simulator (serve-sim) to macOS so builds work on Windows/Linux.

## [0.5.2] - 2026-06-24

### Added

- Favicon for the site and a completed two-tone ring app icon matching the wordmark.

### Changed

- Reworked the README architecture diagram into a GitHub-native Mermaid flowchart describing conceptual layers rather than filenames.
- Refreshed the landing page for native (iOS/Android), the daemon, and mcporter.

### Fixed

- Chrome Web Store preload spam in the packaged app (now loaded as CJS).
- Flaky Electron binary CDN downloads in CI via caching.

## [0.5.1] - 2026-06-23

### Added

- Native lifecycle exposed as MCP tools: `native_open`, `native_close`, and `native_build`.

## [0.5.0] - 2026-06-23

### Added

- Shared stdio HTTP/SSE daemon so one Devloop instance serves many agents.
- Per-project session partitions to isolate same-origin projects.
- React Native network capture (XHR interceptor) feeding the timeline.
- Full network-capture ring for complete, threshold-independent HAR and `get_network` output.
- Viewport/throttle picker UI with device and network dropdowns in the browser bar.

## [0.4.0] - 2026-06-22

### Added

- Android support: a pure adb layer, a `NativeDriver` abstraction wired end-to-end, and cockpit integration with a live screen mirror.

### Changed

- iOS polish: stale-build diagnosis, a native picker, diagnose readiness, and a native smoke test.
- Clearer messaging around the Hermes / RN DevTools conflict plus Metro port discovery.

## [0.3.7] - 2026-06-22

### Fixed

- Chrome Web Store preload now loads correctly, eliminating "Unable to load preload" pane console spam.

## [0.3.6] - 2026-06-22

### Added

- Agent-drivable native iOS interactions and accessibility snapshots via idb.
- iOS readiness UX: a settings preflight panel, readiness banner, and an attention badge on the settings gear when native readiness fails.

### Changed

- Routed `browser_*` calls to the RN controller for the iOS target, with capability-gated repro steps.
- Bumped vendored serve-sim to 0.1.43.

## [0.3.5] - 2026-06-22

### Added

- In-app update banner with spinner, progress, and actions.
- Embedded Chrome Web Store "Add to Devloop" button; the store button toggles between Add and Remove based on install state.

## [0.3.4] - 2026-06-18

### Added

- Playwright/Electron GUI test suite covering the core dev loop, with a macOS CI job.

### Fixed

- Cockpit extension-removal bug.

## [0.3.3] - 2026-06-17

### Fixed

- Vendored serve-sim now ships its `ws` and `inspect-webkit` dependencies so the embedded simulator works.

## [0.3.2] - 2026-06-17

### Fixed

- Vendored serve-sim (with committed `bun.lock`) so the embedded simulator works offline.

## [0.3.1] - 2026-06-17

### Fixed

- Packaged-app `PATH` so bundled dev tooling (serve-sim, expo) is found.

## [0.3.0] - 2026-06-17

### Added

- Native targets (Expo / React Native): a target abstraction with capability gating, a React Native (Hermes) CDP controller, native iOS logs and screenshots wired to the timeline.
- Native build runner with fingerprint recording and a cockpit build UI (platform selector, Build button, staleness badge).
- In-pane interactive iOS simulator via serve-sim (MJPEG / serve-sim preview).
- Expo project UX with a Web/iOS target switcher and bundler/build separation.
- Extension enable/disable toggle.

### Changed

- Refactored the cockpit renderer to a zustand store (entries, projects, extensions, and panes).
- Release pipeline auto-promotes the draft to Latest once installers finish.

## [0.2.2] - 2026-06-12

### Changed

- Settings UX split into separate wrench/gear modals with a real Chrome Web Store window.

## [0.2.1] - 2026-06-12

### Added

- Auto-update: checks GitHub on launch with a manual trigger.
- Intel x64 macOS installers built alongside arm64.

## [0.2.0] - 2026-06-12

### Added

- Richer browser interactions: `browser_snapshot`, `browser_wait_for`, hover/scroll/select/press, and `wait_for_idle`.
- Element picker in the cockpit.
- Network inspector with enriched capture and HAR export.
- `browser_clear_storage` to clear cookies, localStorage, and cache.
- Device/viewport emulation and network throttling.
- `diagnose` (grouped/deduped errors and network failures) and `export_bundle` (shareable bug-report bundle).
- Source-map stack resolution for page errors.
- Chrome extension loading from the Web Store and unpacked.
- Test suite: unit tests, a fixture app with a named-assertion smoke/selftest harness, and a CI gate.
- Landing page deployed via GitHub Pages.

### Changed

- macOS code-signing and notarization in CI; release guards that the tag matches the package version.

## [0.1.1] - 2026-06-11

### Changed

- npm publishing switched to Trusted Publishing (OIDC), removing the stored token.

## [0.1.0] - 2026-06-11

### Added

- Initial release of Devloop: a unified single-window "cockpit" putting browser and dev-server logs on one correlated timeline.
- Per-pane dev servers with top-bar controls, plus pane persistence and restore.
- Network request/response body capture and self-healing Electron panes; pop-out and re-dock support.
- React-based cockpit renderer with Tailwind + Radix styling.
- npm packaging for the stdio MCP (MIT licensed) and cross-platform installers via electron-builder.
- CI/release pipeline that builds all installers and publishes via GitHub Actions.
- Devloop branding: logo, icon, and wordmark.

[Unreleased]: https://github.com/vincentvella/devloop/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/vincentvella/devloop/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/vincentvella/devloop/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/vincentvella/devloop/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/vincentvella/devloop/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/vincentvella/devloop/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/vincentvella/devloop/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/vincentvella/devloop/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/vincentvella/devloop/compare/v0.3.7...v0.4.0
[0.3.7]: https://github.com/vincentvella/devloop/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/vincentvella/devloop/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/vincentvella/devloop/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/vincentvella/devloop/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/vincentvella/devloop/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/vincentvella/devloop/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/vincentvella/devloop/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/vincentvella/devloop/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/vincentvella/devloop/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/vincentvella/devloop/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vincentvella/devloop/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/vincentvella/devloop/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vincentvella/devloop/releases/tag/v0.1.0
