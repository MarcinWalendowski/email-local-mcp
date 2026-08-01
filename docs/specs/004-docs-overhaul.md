# Documentation overhaul

Status: Accepted (implementation in progress, targeting v0.0.1-rc.3)

Grounded in the current docs: `README.md`, `SECURITY.md`, `DISTRIBUTION.md`,
`RELEASING.md`, `app/BUILD.md`, `CONTRIBUTING.md`. This spec reorganizes the docs
around the artifacts specs 001 to 003 introduce (a downloadable DMG, one-line
scripts, a cross-platform CLI) and removes duplication and stale references.

## Problem

- **The quickstart is buried.** `README.md` opens with pitch, providers,
  capabilities, and architecture; the actual "Get started" section starts around
  line 96, and the download-the-app path is a paragraph pointing at a build
  guide rather than a download.
- **Security and distribution content is triplicated.** The App Password
  walkthrough, the "keep the password off the model" guidance, and the signing /
  notarization steps each appear in more than one of `README.md`, `SECURITY.md`,
  and `DISTRIBUTION.md`, so they drift.
- **`CONTRIBUTING.md` is stale.** It lists `src/gmail/` as the provider
  directory, but providers live in `src/providers/` (see the README's own "How
  it works" section). It also lists generic IMAP support as an open "good first
  contribution", though IMAP already shipped.
- **Repo metadata lags the product.** The GitHub repo description is still
  Gmail-only, though the product is multi-provider (Gmail, iCloud, Fastmail, any
  IMAP host).
- **No images, templates, or icon.** There is no hero image or screenshot, no
  issue or PR templates, and no app icon.

## Design

### README restructure, quickstart-first

Reorder `README.md` so a first-time visitor can act within the first screenful:

1. Pitch, two or three lines.
2. Hero image.
3. **Install the app**: download the universal DMG, the exact "Open Anyway"
   steps (System Settings, Privacy and Security), and the labeled `xattr`
   alternative (`xattr -dr com.apple.quarantine ...`).
4. **Or: CLI in one line**:
   `git clone https://github.com/MarcinWalendowski/email-local-mcp.git && cd email-local-mcp && ./scripts/setup-cli.sh`.
5. Everything else (tools, providers, architecture, roadmap) below the fold.

The security section in the README shrinks to three bullets plus a link to
`SECURITY.md`, rather than restating the model.

### Single-source-of-truth ownership

Each topic gets exactly one owner doc; every other doc links to it instead of
restating it:

| Topic | Owner |
|---|---|
| Security and threat model, App Password blast radius | `SECURITY.md` |
| Signing and notarization strategy | `docs/DISTRIBUTION.md` (moved from repo root) |
| Release runbook (version bump, tag, `gh release create`, release-notes template) | `RELEASING.md` |
| Build instructions (scripts, `--bundled`, `--show-add-account`) | `app/BUILD.md` |

`app/BUILD.md` is updated to reflect specs 001 and 002: Node IS now bundled in
`--bundled` builds (the old "Node is not bundled in v1" caveat is removed), the
`scripts/` are documented, and the `--show-add-account` launch argument is
noted. `RELEASING.md` keeps the four-places version-bump list it already has
(`package.json`, `src/mcp/server.ts`, and the two `app/project.yml` fields) and
gains a release-notes template plus the one-line `gh release create` command.

### Platform badges split

The single "platform: macOS 13+" badge conflates two things with different
reach. Split it:

- The **app** is macOS 13+.
- The **CLI** is macOS, Windows, and Linux (per spec 003).

### `CONTRIBUTING.md` corrections and GitHub templates

- Fix the project layout: `src/providers/`, not `src/gmail/`.
- Drop already-shipped generic IMAP from the "good first contributions" list;
  the open pieces are Microsoft 365 / OAuth and richer IMAP search.
- Add `.github/ISSUE_TEMPLATE/` with a bug-report form and a feature-request
  form, and `.github/PULL_REQUEST_TEMPLATE.md`.

### Assets and repo metadata

- Commit an app icon and a screenshot (or hero image) under `assets/`.
- Update the GitHub repo description and topics to reflect the multi-provider
  reality, adding topics like `icloud` and `fastmail` alongside the existing
  `gmail` / `imap` / `mcp` set.

### CHANGELOG discipline

The `rc.1` and `rc.2` history is immutable. New entries land under
`[Unreleased]` until `rc.3` is cut, at which point they move into a dated
`## [0.0.1-rc.3]` section (per `RELEASING.md`).

## Verification

- Every internal link in the moved or edited docs resolves: relative paths are
  checked (in particular the `DISTRIBUTION.md` move from repo root to `docs/`
  updates every referrer, including `README.md` and `RELEASING.md`).
- No duplicated section survives: grepping the repo for the App Password
  walkthrough finds exactly one owner (`SECURITY.md`), and grepping for the
  notarization steps finds exactly one owner (`docs/DISTRIBUTION.md`).
- The README quickstart is visible within the first screenful on GitHub (pitch,
  hero image, and the "Install the app" heading all above the fold).
