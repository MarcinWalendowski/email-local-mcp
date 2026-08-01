# Auto-update for the menu-bar app (Sparkle)

Status: Accepted (implemented, shipping in v0.0.1-rc.3)

Grounded in the current code: `app/project.yml`, `app/EmailLocalMCP/Info.plist`,
`app/EmailLocalMCP/AppDelegate.swift`, `scripts/build-app.sh`, `appcast.xml` (repo
root), and the release flow in [`RELEASING.md`](../../RELEASING.md).

## Problem

The app ships as a downloadable DMG (spec 001), but has no way to learn about or
install a newer build. Every release would require each user to notice the GitHub
Release, re-download the DMG, and drag the app over the old one - and while builds
are ad-hoc signed, also to repeat the Gatekeeper and Keychain steps. Prerelease
builds iterate quickly; users staying on a stale rc defeats the point of shipping
fixes. The app must check for updates on launch and periodically, and update
itself.

## Design

### Sparkle 2, automatic mode

[Sparkle](https://sparkle-project.org) 2.x is added as an SPM dependency in
`app/project.yml` (`from: 2.6.0`). `AppDelegate` starts a
`SPUStandardUpdaterController` in `applicationDidFinishLaunching`, and the
menu gains a **Check for Updates… (v\<version\>)** item for manual checks.

On top of Sparkle's launch + scheduled checks, "opening" the running app also
triggers a silent `checkForUpdatesInBackground()`: clicking the menu-bar icon
(`menuWillOpen` on the status menu) and re-opening the app from Finder or
Spotlight (`applicationShouldHandleReopen`). Background checks surface UI only
when an update actually exists, and these triggers are throttled to at most
one check per 15 minutes so repeated clicks don't hammer the feed.

Behavior is configured entirely in the seed `Info.plist`:

| Key | Value | Meaning |
|-----|-------|---------|
| `SUFeedURL` | `https://raw.githubusercontent.com/MarcinWalendowski/email-local-mcp/main/appcast.xml` | the update feed |
| `SUPublicEDKey` | (committed public key) | EdDSA key updates are verified against |
| `SUEnableAutomaticChecks` | `true` | check on launch + on a schedule, no opt-in prompt |
| `SUScheduledCheckInterval` | `21600` | every 6 hours |
| `SUAutomaticallyUpdate` | `true` | download + install silently, apply on quit/relaunch |

The feed is the `appcast.xml` committed at the repo root, served raw from
`main`. Enclosures are the release DMGs already attached to GitHub Releases -
the same artifact a first-time user downloads, so there is no second packaging
format to build.

### Why this is safe with ad-hoc signed builds

Sparkle accepts an update if it is either signed by the same Developer ID as
the running app, or carries a valid EdDSA signature for the app's embedded
`SUPublicEDKey`. Our builds are ad-hoc signed (no Developer ID yet, spec 001),
so the EdDSA path is the trust anchor:

- `generate_keys` (bundled with Sparkle) created the key pair once. The
  **public** key is committed in `Info.plist`; the **private** key lives only
  in the maintainer's login Keychain and is never exported or committed.
- Each release's appcast entry carries `sparkle:edSignature`, produced by
  `generate_appcast` on the maintainer's Mac at release time.
- A tampered or truncated DMG, or a feed edited by anyone without the private
  key, fails verification and is rejected. Serving the feed and enclosures
  over HTTPS from GitHub adds transport integrity on top.

Sparkle installs updates without re-quarantining them, so an update does NOT
repeat the Gatekeeper "Open Anyway" dance. The macOS Keychain "Always Allow"
prompt for the engine's stored App Passwords does reappear once per update
while builds are ad-hoc signed (documented in RELEASING.md's release-notes
template); a future Developer ID signature ends that.

When the maintainer later signs with Developer ID, nothing here changes: the
EdDSA key keeps working across the signing transition, and
`scripts/build-app.sh` already re-signs Sparkle's XPC services, `Autoupdate`,
`Updater.app`, and the framework (in Sparkle's documented inside-out order)
when `DEVELOPER_ID` is set.

### Release flow changes

`RELEASING.md` gains one step: after the DMG is uploaded to the GitHub Release,
run `generate_appcast` against a folder containing the DMG with
`--download-url-prefix` pointing at the release's download URL, then commit and
push the updated `appcast.xml`. Order matters - the appcast must only ever
reference assets that are already downloadable, because every running app
polls the feed.

Sparkle orders versions by `CFBundleVersion` (`CURRENT_PROJECT_VERSION` in
`app/project.yml`), which is already bumped as an integer per release.

### Known limitations

- The feed lives on `main` via raw.githubusercontent.com, which caches for up
  to ~5 minutes; update rollout is not instant. Acceptable for this project.
- An app running straight from the DMG (not dragged to Applications) is
  read-only and app-translocated; Sparkle reports it cannot update there. The
  DMG art and README both push the drag-to-Applications install.
- Rollbacks: pushing an appcast whose newest item is older than the installed
  build does nothing (Sparkle never downgrades). Shipping a fixed higher
  version is the rollback story.

## Verification

Executed on 2026-07-16 (all passed):

1. **Build**: `scripts/build-app.sh` compiles with Sparkle resolved via SPM;
   `codesign --verify --deep --strict` passes with the embedded framework.
2. **Runtime update E2E** (local): installed a build with
   `CFBundleVersion=3`, served a `generate_appcast`-signed zip of a
   `CFBundleVersion=4` build from `http://localhost:8000` (feed overridden via
   `defaults write com.lokilabs.EmailLocalMCP SUFeedURL ...`), launched the old
   app. Sparkle checked on launch, downloaded and EdDSA-verified the update
   silently, and installing happened on quit: the bundle on disk reported
   `CFBundleVersion` 4 afterwards. Test defaults and caches were removed.
3. **Menu**: "Check for Updates… (v0.0.1)" appears and triggers a check.
4. **Open-triggered checks**: with the feed pointed at a localhost server and
   the request log watched: app launch produced fetch #1, re-opening the
   running app produced fetch #2 (`applicationShouldHandleReopen` →
   `backgroundUpdateCheck`), and an immediate second reopen produced no fetch
   (15-minute throttle). The menu-click trigger runs the same helper.

Per release, the verification is: after pushing the updated appcast, run the
previous release's app and confirm it offers/installs the new version.
