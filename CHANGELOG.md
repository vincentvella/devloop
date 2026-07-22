# Changelog

All notable changes to **devloop** (npm `devloop-mcp`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _Nothing yet._

## [0.10.2] - 2026-07-22

### Fixed
- **`npx devloop-mcp` installs on node 22 LTS again.** The published `engines.node` floor had been raised to `>=24.18.0` as a side effect of a dependency bot pinning the CI runner, telling node 22 and 23 users the package was unsupported. The floor now tracks what the shipped bundle actually needs (`>=22.12.0`, from puppeteer) — verified by running the built bundle under node 22.12.0 end to end, including a real Chrome launch.

### Changed
- The cockpit now runs on **Electron 43** (newer Chromium). Storage clearing drops the `websql` bucket, which Chromium itself removed — the same set of data is still cleared.

### Tooling
- Typechecking moves to **TypeScript 7**, the native compiler port. No source changes were needed; `tsc` is only ever run with `--noEmit`, so this swaps the typechecker and nothing else.
- `@types/node` now tracks the `engines` floor (22.x) instead of drifting ahead of it, so the typechecker can't accept APIs that would crash on the oldest supported node.
- The dependency audit gate is scoped to high+ severity. `bun audit` has no workspace filter, so an unfixable low in the (never-published) marketing site's tree was failing CI on every PR.
- `sharp` is pinned past the libvips CVEs (GHSA-f88m-g3jw-g9cj) via an override — neither Next 15 nor 16 can resolve the fixed line on its own. Site-only; not part of the published package.
- Renovate no longer rewrites the published `engines` contract, and is capped to 22.x for `@types/node`.
- Biome 2.5.4, postcss 8.5.20.

## [0.10.1] - 2026-07-11

### Fixed
- The Android device mirror no longer stretches — it renders at the device's true aspect ratio (from `wm size`), letterboxed to fit the pane.
- The fatal-error log keeps the error message even when source-map tooling reformats the stack trace (the same hardening crash reports got in 0.10.0).

### Tooling
- Unit tests for the shared-mode daemon bridge, the Android mirror, and the daemon client.
- The release npm-publish step retries through the intermittent `sigstore` self-install failure, so a flaky publish no longer needs a manual re-run.

## [0.10.0] - 2026-07-10

### Added
- **Keyboard cheatsheet + native menu bar** — press `⌘/` for a list of every shortcut, plus a full native menu (App · Edit · View · Navigate · Window · Help) whose accelerators mirror them. `⌘F` now focuses the log filter.
- **Per-pane native log scoping** — native (iOS/Android) device logs are attributed to the pane's app, with an opt-in device/system lane for logs that aren't.
- **Auto-assigned Metro/Expo port per pane** — run several native apps side by side without the `:8081` collision; each pane's dev-client is pointed at its own bundler.
- Agent-created panes are now named from their project.

### Changed
- **Timeline log-view overhaul** — identical consecutive lines collapse into one row with a `×N` count, repeated timestamp/source/pane metadata is hidden, `os_log` subsystem prefixes are dimmed, and the list is virtualized so a busy timeline stays smooth. Log rows also use the full width.

### Fixed
- **Native multi-pane flow** — panes use an all-target `expo start` (not the web-only bundler), the dev-client is re-pointed at the pane's own Metro (no more cross-wiring between apps), the "detecting…" probe can't hang, a chatty native log stream no longer freezes the UI, the dev server is reliably reaped on exit (no leaked ports), the iOS bundle id resolves correctly, and pressing play on a native target opens the simulator.
- `native_build` binds the pane's Metro port so a freshly-built app connects to the right project's bundler.
- `diagnose()` now surfaces native (iOS/Android) crash log lines instead of reporting "no errors detected".
- The MCP HTTP transport binds loopback (`127.0.0.1`) by default rather than all interfaces.
- Crash reports keep the error message even when source-map tooling reformats the stack trace.

### Tooling
- Unit tests for `androidMirror` and `daemonClient`; dependency bumps (Remotion, Biome, cockpit UI).

### Docs
- `devloop.build` rebuilt as a Next.js app (Bun workspace) and moved to Vercel; the legacy static GitHub Pages site was removed.

## [0.9.1] - 2026-07-01

### Added
- Swapping panes while an iOS sim / Android mirror is up now foregrounds that pane's app on the device; if the app isn't installed it goes to the Home screen instead of leaving the previous pane's app on screen.
- An "initializing iOS/Android…" indicator while the simulator / mirror comes up.

### Fixed
- The native-build ⚠ staleness badge now clears after a successful build (it had been compared against a cached fingerprint that the build didn't refresh).

## [0.9.0] - 2026-07-01

### Added
- Native **target switcher** in the browser bar — Web / iOS / Android for Expo & React Native projects. The Web target is resolved authoritatively via `expo config` (honors `app.config.ts`), backed by a persisted, content-hashed detection cache so it's instant after the first resolve; a "detecting project…" indicator shows while detection runs.
- **`+` launcher** — open or create a project directly into a new pane.
- **`bun run app`** now watches, rebuilds, and relaunches the cockpit on source changes (no more stale builds).
- **native_doctor** — re-check native readiness without kicking off a build; a local-first Android build-readiness doctor (the EAS cloud path is gone).

### Changed
- The pane **wrench** now edits *that pane only*; opening another project is the `+` button.

### Fixed
- Target-switcher flicker from stale async detection results.
- Atomic build swap — no window where a partial build is on disk.
- Saving a project updates the pane's tab name immediately.
- State is isolated per environment (dev / packaged / selftest); dead unpacked-extension entries self-heal.
- Startup IPC race (the pane manager is created before IPC registration); the Doctor modal + native picker detach the pane so they aren't hidden behind it; pane project/dev inputs no longer clip.

### Tooling
- Target-detection test matrix + opt-in Expo fixtures.

### Docs
- Clarified that devloop diagnoses toolchain gaps but never installs; added a "use it from your coding agent" guide.

## [0.8.0] - 2026-06-30

### Added

- **Configurable `browser_snapshot` cap** — a `limit` parameter (default 250, override globally via `DEVLOOP_SNAPSHOT_MAX`) so dense tables / long forms aren't silently truncated. Still emits `truncated` when the cap is hit.

### Fixed

- **Advertised MCP version is read from `package.json`** — it was hardcoded and stale (`0.5.2` / `0.6.0`), so every connecting client (and the daemon bridge) saw the wrong version; the HAR `creator` version is sourced from it too.
- **Dev-server crash output is no longer dropped** — `DevServer` now flushes the final partial line when the stream closes, so crash output without a trailing newline (segfault / `EADDRINUSE` / uncaught-exception dumps) reaches the timeline.
- **The daemon can't hang or OOM on a bad request** — the HTTP transport's body reader settles on a socket `error` and caps bodies at 4 MB (responds `400`), instead of leaving the handler (and its response) suspended forever.
- **Bounded source-map cache** — the resolver's `TraceMap` cache is now an LRU (default 100), so long daemon/cockpit sessions don't leak memory across hash-versioned bundle URLs.

### Changed

- **Compile-time tool-dispatch safety** — `defineTool` preserves literal tool names and `handleTool`'s switch is exhaustiveness-checked, so adding a tool to `toolSpecs.ts` without a handler now fails `bun run typecheck`.
- Dependency bumps: **Remotion 4.0.484** (`remotion` + `@remotion/cli`).

### Tooling

- Large unit-test expansion (no Chrome/Electron needed): `handleTool` dispatch (browser / pane / dev-server / logs / repro), the Puppeteer controller (recovery · console enrichment · network listeners), `daemonState`, `resolveTargets`, the `DevServer` lifecycle, the `httpMcp` body reader, the source-map LRU, and a version-drift guard.

### Docs

- README: corrected the tool count (37 → **45**), documented the 8 previously-undocumented tools (`browser_back`/`forward`/`reload`, `pane_set_label`, `ext_*`) and `DEVLOOP_NET_RING`, and moved shipped items out of "Where to take it next".

## [0.7.1] - 2026-06-27

### Added

- **EAS cloud-build fallback** — `native_build({ platform, eas: true })` builds in the EAS cloud (`eas build`, development profile) instead of a local `expo run`, for when there's no local native toolchain.

### Changed

- **Cockpit decomposition** — `cockpit/main.ts` (~1540 lines) split into focused modules: `selftest/*` (the integration suite), `extensions.ts`, `nativeTargets.ts`, and `ipc.ts` (the 61 IPC channels), behind factories. `main.ts` is now ~380 lines (window creation + boot + lifecycle). Structural only — no behavior change.

### Fixed

- Hardened the cockpit selftest's `interactions (select/press/hover)` step against a CI timing flake (wait for the doc to be interactive, then retry the idempotent actions).

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

[Unreleased]: https://github.com/vincentvella/devloop/compare/v0.10.2...HEAD
[0.10.2]: https://github.com/vincentvella/devloop/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/vincentvella/devloop/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/vincentvella/devloop/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/vincentvella/devloop/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/vincentvella/devloop/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/vincentvella/devloop/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/vincentvella/devloop/compare/v0.7.0...v0.7.1
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
