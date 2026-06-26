---
name: release
description: Cut a new devloop release — bump the version across all files, update the changelog, commit, tag, and trigger the publish workflow. Use when asked to "cut a release", "ship a version", or "publish a new version" of devloop-mcp.
---

# Cut a devloop release

Releases are **tag-triggered**: pushing a `vX.Y.Z` tag fires `.github/workflows/release.yml`,
which builds the cross-platform installers, publishes to npm (GitHub OIDC — no token), and
publishes to the MCP Registry. A `verify-version` guard **fails the release if the tag does
not exactly match `package.json` version**, so the bump must land before the tag.

## 0. Preconditions (don't skip)

- Latest `main` CI is green (`gh run list --workflow ci.yml --branch main --limit 1`).
- Run the heavy suites locally if the changes touched the cockpit/renderer:
  - `bun run app:gui` — the GUI click-through suite (Playwright + Electron).
  - `bun run app:selftest` — offscreen cockpit selftest.
  - (`bun test`, `bun run test-smoke.ts`, `bun run test:daemon`, `bun run test:mcporter` are CI-gated.)
- Working tree clean; you're on `main` and up to date (`git pull --rebase origin main`).

## 1. Pick the version (SemVer, project is 0.x)

- **patch** (`0.6.2 → 0.6.3`): fixes, deps, docs, internal tooling only.
- **minor** (`0.6.2 → 0.7.0`): any new user-facing feature (e.g. a new cockpit affordance or MCP tool), or a notable batch of dependency bumps.
- **major**: reserved; not used pre-1.0.

## 2. Bump the version in ALL FOUR places

These must stay in lockstep — the registry/Docker/guard all read them:

- `package.json` — top-level `"version"`.
- `server.json` — **two** spots: top-level `"version"` AND `packages[0].version`.
- `Dockerfile` — `RUN npm install -g devloop-mcp@X.Y.Z`.

Verify they match:

```sh
node -e "const p=require('./package.json'),s=require('./server.json');console.log(p.version,s.version,s.packages[0].version)"
grep -oE 'devloop-mcp@[0-9.]+' Dockerfile
```

## 3. Update CHANGELOG.md

Keep-a-Changelog format. In `CHANGELOG.md`:

1. Replace the `## [Unreleased]` body with a new dated section, then leave a fresh empty Unreleased above it:
   ```md
   ## [Unreleased]

   - _Nothing yet._

   ## [X.Y.Z] - YYYY-MM-DD
   ### Added / Changed / Fixed / Tooling / Docs
   - …
   ```
   Use today's date. Synthesize user-facing bullets from `git log --oneline vPREV..HEAD` — don't paste raw commits.
2. Update the link refs at the bottom:
   ```md
   [Unreleased]: https://github.com/vincentvella/devloop/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/vincentvella/devloop/compare/vPREV...vX.Y.Z
   ```

## 4. Gate, commit, push, tag

```sh
bun run check                      # Biome lint+format gate (must be clean)
git add package.json server.json Dockerfile CHANGELOG.md
git commit -m "release: X.Y.Z"     # + the Co-Authored-By trailer (see Conventions)
git pull --rebase origin main && git push origin HEAD
git tag -a vX.Y.Z -m "devloop X.Y.Z"
git push origin vX.Y.Z             # ← this triggers the release workflow
```

## 5. Verify the publish

```sh
RID=$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RID" --exit-status
npm view devloop-mcp version       # should equal X.Y.Z
```

The MCP Registry job is idempotent (skips if the version is already published). Glama re-syncs
from the new tag automatically. If the run fails on `verify-version`, the tag and `package.json`
disagree — fix the bump, delete + re-push the tag.

## Conventions (apply to every commit, not just releases)

- **Conventional Commits**: `feat(scope): …`, `fix(deps): …`, `chore: …`, `test(smoke): …`, `docs: …`, `release: X.Y.Z`.
- Run `bun run check` (Biome) before committing; CI gates it.
- **bun, never npm/npx** for dev commands.
- End commit messages with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- Only commit/push when asked. If on `main`, that's the release norm here; for feature work prefer a branch + PR.
