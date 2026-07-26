# Releasing AnyMail MCP

AnyMail MCP follows [SemVer](https://semver.org). Releases are cut manually on a Mac:
the universal DMG is built locally with `npm run app:dmg` and attached to a GitHub
Release. There is no tag-driven CI that builds or signs the app yet (notarization
needs an Apple Developer account and signing secrets), so the steps below are the
whole flow. The full distribution design is in [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

## Cut a release

1. **Bump the version** in all four places so they agree:
   - `package.json` → `version`
   - `src/node/mcp/server.ts` → the `McpServer({ version })` string. This is what
     the engine reports to agents in `initialize`, so a stale value misreports the
     running build. Easy to miss; check it.
   - `app/project.yml` → `MARKETING_VERSION` (Apple requires one-to-three integers
     here, so a pre-release suffix like `-rc.3` lives in `package.json` and the tag,
     not in this field).
   - `app/project.yml` → `CURRENT_PROJECT_VERSION` (integer build number, +1).
     This is also what Sparkle compares to decide whether an installed app
     updates, so a release that forgets this bump is invisible to auto-update.
2. **Update `CHANGELOG.md`**: move items out of `[Unreleased]` into a new dated
   `## [x.y.z]` section, and update the compare/tag links at the bottom.
   `core/package.json` is deliberately **not** on this list — see below.
3. **Verify** the engine: `npm ci && npm run build && npm run typecheck`.
4. **Build the DMG** (universal, ad-hoc signed):
   ```bash
   npm run app:dmg      # → AnyMail-MCP-<version>-universal.dmg
   ```
   To ship a **notarized** DMG instead, set `DEVELOPER_ID` (and notarytool
   credentials) first; the pipeline switches paths automatically. See
   [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).
5. **Commit** (`release: vX.Y.Z`), then **tag**:
   ```bash
   git tag -a vX.Y.Z -m "AnyMail MCP vX.Y.Z"
   git push origin main --tags
   ```
6. **Publish the GitHub Release** with the DMG attached. Write the notes into a file
   (see the template below), then:
   ```bash
   gh release create v0.0.1-rc.3 --prerelease --title "v0.0.1-rc.3" \
     --notes-file notes.md \
     AnyMail-MCP-0.0.1-rc.3-universal.dmg
   ```
   Drop `--prerelease` once the version is stable (no `-rc` / `-beta` suffix). For a
   final release you can generate the notes straight from the changelog instead:
   ```bash
   gh release create vX.Y.Z --title "AnyMail MCP vX.Y.Z" \
     --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md) \
     AnyMail-MCP-X.Y.Z-universal.dmg
   ```
7. **Update the appcast** so installed apps auto-update
   ([`docs/specs/005-auto-update.md`](docs/specs/005-auto-update.md)). Run this
   **after** the release is published; the appcast must never reference an asset
   that isn't downloadable yet:
   ```bash
   mkdir -p /tmp/appcast && cp AnyMail-MCP-X.Y.Z-universal.dmg /tmp/appcast/
   app/build/DerivedData/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_appcast \
     --download-url-prefix "https://github.com/MarcinWalendowski/anymail-mcp/releases/download/vX.Y.Z/" \
     -o appcast.xml /tmp/appcast
   git add appcast.xml && git commit -m "release: point appcast at vX.Y.Z" && git push
   ```
   `generate_appcast` signs the entry with the Sparkle EdDSA **private key in
   your login Keychain** (created once by `generate_keys`; the matching public
   key is committed in `app/AnyMailMCP/Info.plist`). That key exists only on
   your Mac; never export or commit it, and keep a backup
   (`generate_keys -x sparkle-private-key.backup` to an encrypted disk/password
   manager); losing it means shipped apps can never accept another update.
   To verify: run the *previous* release's app and confirm it updates itself.

## Releasing `anymail-core` (separate, and separately versioned)

`core/` publishes the portable tool layer to npm as **`anymail-core`**. It has
its **own semver**, unrelated to the app's version, and is released on its own
schedule: the app can ship ten times without the tool vocabulary changing, and
core can ship a fix that no app user ever sees. Bumping it in step 1 alongside
the other four would be wrong — that list exists because those four describe the
*same* artifact, and this is a different one.

```bash
npm run pack:core                # build + npm pack, inspect the tarball first
npm publish ./core --access public
```

What "breaking" means here is narrower and stricter than usual: **a change to a
tool name, an input schema, or a description is a breaking change to every agent
using either deployment**, even when it is a pure TypeScript refactor. Capture
`npm run surface` before and after, and if the diff is non-empty, say so in the
changelog and bump accordingly. Additive tools are a minor; anything renamed,
removed or re-described is a major.

## Release-notes template

Keep it short. Highlights first (what a user cares about), then the changelog section
verbatim, then the install + Gatekeeper note, then known limitations.

```markdown
## Highlights
- <the one or two things worth downloading this build for>

## Changes
<paste the dated CHANGELOG section for this version>

## Install
Download `AnyMail-MCP-<version>-universal.dmg` below (one universal build for Apple
Silicon and Intel, Node is bundled, no prerequisites). Open it and drag **AnyMail MCP**
to Applications. The build is ad-hoc signed and not yet notarized, so the first launch
is blocked: open **System Settings > Privacy & Security**, scroll to the "AnyMail MCP
was blocked" notice, and click **Open Anyway**.

Already running AnyMail MCP? Nothing to do: the app checks for updates on launch
and every 6 hours and installs them itself.

CLI only: `git clone https://github.com/MarcinWalendowski/anymail-mcp.git && cd anymail-mcp && ./scripts/setup-cli.sh`

## Known limitations
- Not notarized yet, so the first launch needs the Gatekeeper "Open Anyway" step.
- macOS re-shows the Keychain "Always Allow" prompt after each app update while builds
  are ad-hoc signed (a Developer ID signature will end that).
- <anything version-specific, e.g. Intel slice not runtime-verified>
```

## Distribution channels

Current and planned ways users get AnyMail MCP:

| Channel | Status | Notes |
|---------|--------|-------|
| Clone + `./scripts/setup-cli.sh` | ✅ now | The CLI path in the README. Runs on macOS, Windows, Linux. |
| Universal DMG (ad-hoc signed) | ✅ now | Built with `npm run app:dmg`, attached to the GitHub Release. First launch needs the Gatekeeper "Open Anyway" step. |
| Signed & notarized DMG | ⏳ roadmap | Same pipeline with `DEVELOPER_ID` set; needs an Apple Developer ID + `xcrun notarytool`. Then the app opens on a double-click. |
| Homebrew | ⏳ roadmap | A formula for the CLI/engine and/or a cask for the notarized app. |
| `npm` / `npx` | ⏳ roadmap | Set `"private": false` in `package.json`, add `"files": ["dist"]`, then `npm publish`. |
| Mac App Store | ❌ not planned | MAS requires the App Sandbox, which forbids spawning a `node` child process and writing other apps' MCP configs, core to how AnyMail MCP works. |

The signing, notarization, and CI-release details for the roadmap channels live in
[`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).
