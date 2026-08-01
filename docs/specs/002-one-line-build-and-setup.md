# One-line build and setup scripts

Status: Accepted (implementation in progress, targeting v0.0.1-rc.3)

Grounded in the current code: `app/BUILD.md`, `app/project.yml`,
`scripts/make-dmg.sh`, `package.json`. This spec is the tooling counterpart to
[spec 001](001-self-contained-app-and-dmg.md): 001 defines what a self-contained
app looks like, this defines the scripts that produce it reproducibly.

## Problem

Building the app or setting up the CLI today is a multi-step manual affair spread
across `app/BUILD.md` and the README: install XcodeGen, build the engine, run
`xcodegen generate`, open Xcode, set a signing team, build. There was no
reproducible DMG pipeline at all (only `scripts/make-dmg.sh` existed, and it
assumes a pre-built `.app`). A contributor cannot go from a clean checkout to a
universal DMG with one command, and CI cannot either.

## Design

A small set of scripts under `scripts/`, each idempotent and CI-friendly, plus
npm aliases in `package.json`. Each script does one job and can be composed. The
scripts print machine-readable output where another script consumes it.

### `scripts/stage-engine.sh`

Produces the staged engine that spec 001 bundles. Steps:

1. Download both Node tarballs (`darwin-arm64`, `darwin-x64`) for the pinned
   `NODE_VERSION`, caching them in `~/Library/Caches/email-local-mcp-build/` so
   repeat runs are offline and fast.
2. Verify each tarball against `SHASUMS256.txt`, then `lipo`-merge the two
   `node` binaries into a universal `bin/node`.
3. Install production dependencies in isolation: `npm ci --omit=dev
   --ignore-scripts` inside a `mktemp` directory (so the repo's own
   `node_modules` and lifecycle scripts are never touched).
4. Graft the `darwin-x64` keyring addon (see spec 001) so both architectures
   resolve at runtime.
5. Prune docs, type declarations, source maps, and tests out of `node_modules`
   to hold the size down.
6. Copy `dist/`, the pruned `node_modules`, and a `package.json` carrying
   `"type":"module"` into `app/build/engine-staging/`.
7. Smoke-test the staging: the staged node runs `dist/index.js help`, the
   keyring module imports cleanly, and `lipo -archs bin/node` asserts both
   slices are present.

### `scripts/build-app.sh [--bundled] [--configuration Release|Debug] [--open]`

Builds the `.app`:

1. Preflight checks (XcodeGen present, engine built when needed).
2. `xcodegen generate`.
3. When `--bundled` is passed, run `stage-engine.sh` first.
4. `xcodebuild ... BUNDLE_ENGINE=YES ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO`
   for a universal build.
5. When the `DEVELOPER_ID` env var is set, perform the inside-out re-sign
   described in [spec 001](001-self-contained-app-and-dmg.md) (keyring addons,
   then `bin/node` with `engine.entitlements`, then the app last, no `--deep`).
   Absent `DEVELOPER_ID`, the ad-hoc path runs and the engine is left untouched.
6. Print the built `.app` path as the last line of output, so `make-dmg.sh` (or
   CI) can capture it.

A plain `scripts/build-app.sh` with no `--bundled` behaves exactly like a normal
dev build: no engine staging, fast, unchanged from the pre-script flow.

### `scripts/make-dmg.sh [app-path]`

Already exists for the "sign and lay out a pre-built app" case. Extended so that
with no argument it invokes `build-app.sh --bundled` first, then produces
`Email-Local-MCP-<version>-universal.dmg` via `create-dmg` with the volume icon and
the drag-to-Applications layout it already lays out. When `DEVELOPER_ID` is set
it also signs the DMG (the existing `--codesign` hook).

### `scripts/setup-cli.sh [--install-agents]`

The one-line CLI path referenced by the README:

1. Check `node >= 18`, printing an install hint if missing.
2. `npm ci` (falling back to `npm install` when there is no lockfile match).
3. `npm run build`.
4. With `--install-agents`, run the agent-config installer (`node dist/index.js
   install`).

### `scripts/make-icon.sh`

Renders `assets/app-icon.svg` at every required icon size via `rsvg-convert`
plus `iconutil`, producing `app/EmailLocalMCP/AppIcon.icns`. The `.icns` is
committed to the repo, so a contributor without librsvg installed can still
build the app; the script is only needed when the icon art changes.

### Xcode integration (`app/project.yml`)

`project.yml` gains a post-build copy phase, gated on `BUNDLE_ENGINE=YES`, that
copies `app/build/engine-staging/` into
`$CODESIGNING_FOLDER_PATH/Contents/Resources/engine` before code signing (so the
signature covers the bundled engine). A plain dev build has `BUNDLE_ENGINE`
unset, so the phase is skipped instantly. The phase fails loudly if
`BUNDLE_ENGINE=YES` but the staging directory is missing, rather than shipping an
app with no engine. The project also sets `ENABLE_USER_SCRIPT_SANDBOXING: NO` so
the copy phase can read the staging directory.

### npm aliases (`package.json`)

For discoverability the scripts are also reachable through npm:

- `npm run app:build` , `scripts/build-app.sh`
- `npm run app:dmg` , `scripts/make-dmg.sh`
- `npm run setup` , `scripts/setup-cli.sh`

### QA affordance

The app accepts a launch argument `--show-add-account` that opens the Add Account
window immediately on launch, so screenshots and UI QA do not require clicking
through the menu-bar item each time.

## Verification

- A plain `scripts/build-app.sh` dev build is byte-identical in behavior to the
  pre-change manual build: no engine bundling, no signing, same `.app` layout.
- `scripts/make-dmg.sh` produces the universal DMG end to end on a clean checkout
  with only the brew dependencies installed (`xcodegen`, `create-dmg`, and
  `librsvg` for the background and icon).
- `stage-engine.sh` self-smoke-tests: staged node runs `dist/index.js help`, the
  keyring module imports, and `lipo -archs bin/node` shows both slices.
- `npm run typecheck` stays green (the scripts add no TypeScript surface).
