# Self-contained app bundle and DMG distribution

Status: Accepted (implementation in progress, targeting v0.0.1-rc.3)

Grounded in the current code: `app/EmailLocalMCP/NodeLocator.swift`,
`app/EmailLocalMCP/EngineSupervisor.swift`, `app/project.yml`, `src/keychain.ts`.
The distribution strategy and signing rationale live in
[`DISTRIBUTION.md`](../DISTRIBUTION.md); this spec covers the one item that
makes "download and run" true, the self-contained engine plus a DMG.

## Problem

The menu-bar app supervises a Node engine child process
(`node dist/index.js --http`, see `EngineSupervisor`). Today that `node` has to
be the user's own install. `NodeLocator.find` probes only system paths
(`/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`), an optional
user override, and nvm. `EnginePaths.entry` already looks for a bundled
`Resources/engine/dist/index.js` first, but nothing ships there, so it falls
<!-- name-check: legacy-ok — the pre-change state this spec set out to fix. -->
through to the `~/loki-labs/email-local-mcp` dev checkout.
<!-- name-check: /legacy-ok -->

The result: there is no downloadable artifact, and a user must clone the repo,
install Node, and build the engine before the app runs. A person who downloads a
`.app` and has no Node (or no Homebrew) gets a dead menu-bar icon. We want a
single universal DMG that runs on any recent Mac with zero prerequisites.

## Design

### Bundle a pinned runtime and the built engine

Ship everything the engine needs inside the app at `Contents/Resources/engine/`:

```
Contents/Resources/engine/
  bin/node              # pinned Node runtime (NODE_VERSION=22.12.0), universal
  dist/index.js         # the built engine entry (already an EnginePaths slot)
  node_modules/         # production deps only (@napi-rs/keyring, imapflow, ...)
  package.json          # MUST contain "type":"module" (mandatory for ESM)
```

The `"type":"module"` line is not optional: the engine is ESM, and without it
Node treats the bundled `dist/index.js` as CommonJS and refuses to load.

Two Swift-side changes make the app prefer the bundle over a system Node:

- The engine entry slot (`Resources/engine/dist/index.js`) already exists first
  in `EnginePaths.entry`, so nothing changes there.
- A new bundled-node candidate (`Resources/engine/bin/node`) is inserted into
  `NodeLocator.find`, after the user override but before the system paths. The
  override still wins (so a developer can point at their own node), then the
  bundled runtime, then the system candidates as a last resort.

### Universal binary (arm64 + x86_64)

The DMG is one artifact for both Apple Silicon and Intel. The build downloads
BOTH official Node tarballs (`darwin-arm64` and `darwin-x64`), verifies each
against the published `SHASUMS256.txt`, and `lipo -create`s them into a single
universal `bin/node`.

The native keyring addon needs the same treatment. `@napi-rs/keyring` resolves
its native binary per `process.arch` at runtime through the napi loader. A normal
lockfile install on an Apple Silicon build machine only yields
`@napi-rs/keyring-darwin-arm64`. The x64 sibling package
(`@napi-rs/keyring-darwin-x64`) is grafted in via `npm pack` plus extract, so
both `.node` binaries are present and the loader picks the right one on either
architecture.

### Signing model: do NOT re-sign the engine in the ad-hoc build

This is the key subtlety. The official Node.js binary is Developer-ID signed by
the OpenJS Foundation, and it already carries
`com.apple.security.cs.disable-library-validation` plus the JIT entitlements V8
requires. The ad-hoc build pipeline must therefore leave the engine untouched:
ad-hoc re-signing `bin/node` would strip the OpenJS signature and its
entitlements, which breaks native addon loading (library validation would then
reject the third-party keyring `.node`).

Re-signing the engine happens only on the future Developer-ID branch, and only
there. That branch re-signs the whole bundle inside-out (`DISTRIBUTION.md`
step 2b): the keyring `.node` addons first, then `bin/node` with a dedicated
`engine.entitlements`, then the `.app` last, and never with `--deep`. The engine
entitlements grant JIT (`com.apple.security.cs.allow-jit`), unsigned executable
memory (`com.apple.security.cs.allow-unsigned-executable-memory`), and
`com.apple.security.cs.disable-library-validation`, and explicitly do NOT grant
`get-task-allow` (a debuggable binary fails notarization).

To keep the two paths clear:

| | Ad-hoc DMG (this spec) | Developer-ID DMG (future) |
|---|---|---|
| `bin/node` | left as-is, keeps OpenJS signature | re-signed with `engine.entitlements` |
| keyring `.node` | left as-is | re-signed under Developer ID |
| `.app` | ad-hoc signed | re-signed last, no `--deep` |
| Gatekeeper | needs Open Anyway once | opens on double-click |

### Gatekeeper story for the ad-hoc DMG (macOS Sequoia)

An ad-hoc-signed app is not notarized, so the first open is blocked. The user
has two documented paths:

1. System Settings, Privacy and Security, then "Open Anyway" (the button appears
   after the first blocked launch attempt).
2. Or clear the quarantine flag directly:
   `xattr -dr com.apple.quarantine "/Applications/Email Local MCP.app"`.

Note on app translocation: when Gatekeeper runs a quarantined app it may
translocate it, running from a randomized read-only mount until the user moves
it out of the download location. The app survives this because it resolves every
path relative to `Bundle.main.resourceURL` (see `EnginePaths.entry`), so the
bundled engine is found wherever the app runs from. The DMG layout still nudges
the user to drag the app to `/Applications` (a drop-link and arrow, see
`scripts/make-dmg.sh`), which sidesteps translocation entirely.

### Notarization upgrade path (env-driven, no code change)

Moving from the ad-hoc DMG to a notarized one is a maintainer credential step,
not a code change. Once the maintainer has a Developer ID Application
certificate and has stored notarytool credentials
(`xcrun notarytool store-credentials`), the same scripts produce a notarized
DMG:

```bash
DEVELOPER_ID="Developer ID Application: NAME (TEAMID)" scripts/make-dmg.sh
xcrun notarytool submit "Email-Local-MCP-<version>-universal.dmg" --wait
xcrun stapler staple "Email-Local-MCP-<version>-universal.dmg"
```

The presence of `DEVELOPER_ID` in the environment switches the pipeline onto the
inside-out re-sign path; absent it, the ad-hoc path runs. See
[`DISTRIBUTION.md`](../DISTRIBUTION.md) for the full runbook.

### Known trade-offs

- **DMG size roughly doubles.** A universal Node plus production `node_modules`
  makes the uncompressed engine around 80 to 110 MB. Compression helps in the
  DMG, but the download is materially larger than a source clone.
- **Keychain re-prompts under ad-hoc signing.** macOS Keychain ACLs are tied to
  the signing identity of the process that created the item. Under ad-hoc
  signing the identity changes whenever the binary changes, so each update
  re-prompts "Always Allow" once per binary change (see the caching note in
  `src/keychain.ts` for why the prompt matters). A Developer ID signature fixes
  this durably, because the identity is stable across releases.
- **x64 verification limits.** On an Apple Silicon build machine without Rosetta,
  the x86_64 slice can only be statically verified (`lipo`, `codesign`), not
  executed. Runtime proof of the Intel slice needs an Intel Mac or a Rosetta
  runner.

## Verification

Automated / static checks on the built app:

- `codesign --verify --deep --strict "Email Local MCP.app"` passes (`--deep` is fine
  for verifying; it is only banned for applying signatures).
- `lipo -archs "Email Local MCP.app/Contents/MacOS/Email Local MCP"` reports
  `x86_64 arm64`, and the same for
  `Contents/Resources/engine/bin/node`.
- In the ad-hoc build, the bundled node keeps the OpenJS TeamIdentifier:
  `codesign -dvvv Contents/Resources/engine/bin/node` shows
  `TeamIdentifier=HX7739G8FX`.

Runtime checks on a clean Mac:

- The app spawns the bundled node, not a system one:
  `pgrep -fl 'Resources/engine/bin/node'` lists the running engine.
- `curl 127.0.0.1:8765/admin/health` returns ok.

Owner QA (a second Mac that has never seen the app):

- Download the quarantined DMG, drag to `/Applications`, and walk the Gatekeeper
  "Open Anyway" path. Confirm the app launches, the engine starts, and an
  account can be added and tested end to end.
