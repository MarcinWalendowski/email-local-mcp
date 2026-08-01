#!/usr/bin/env bash
#
# brew-sync.sh - stamp the tap's version + checksums from the PUBLISHED
# artifacts, and optionally copy the result into the tap repo.
#
# WHY THIS IS A SCRIPT. A formula carries a sha256 of a tarball that does not
# exist until after the release, so the checksum can only ever be filled in by
# hand at the worst possible moment: after the release is out and while
# somebody is watching. A hand-typed sha256 that is wrong does not fail loudly,
# it fails on a stranger's machine with "SHA256 mismatch" and no way to tell
# whether the tap is stale or the download was tampered with.
#
# So the checksums are read from the artifacts themselves, never typed.
#
#   scripts/brew-sync.sh                     stamp packaging/homebrew/ in place
#   scripts/brew-sync.sh --tap ../homebrew-tap   also copy into the tap checkout
#
# Run it AFTER `npm publish` and AFTER the DMG is attached to the GitHub
# release. It refuses to stamp anything it cannot download.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
PKG="$(node -p "require('$ROOT/package.json').name")"
REPO="MarcinWalendowski/email-local-mcp"

FORMULA="$ROOT/packaging/homebrew/Formula/email-local-mcp.rb"
CASK="$ROOT/packaging/homebrew/Casks/email-local-mcp.rb"

TAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tap) TAP="${2:?--tap needs a path}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m%s\033[0m\n' "$*"; }
die() { printf '\033[31mbrew-sync: %s\033[0m\n' "$*" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── the npm tarball ────────────────────────────────────────────────────────
#
# Taken from the registry rather than from a local `npm pack`, because a local
# pack can differ from what was published (dirty tree, stale build) and the
# formula has to match the bytes users actually download.

TARBALL_URL="https://registry.npmjs.org/${PKG}/-/${PKG}-${VERSION}.tgz"
say "fetching $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$TMP/pkg.tgz" \
  || die "npm tarball not found. Has 'npm publish' run for ${PKG}@${VERSION}?"
NPM_SHA="$(shasum -a 256 "$TMP/pkg.tgz" | cut -d' ' -f1)"
say "  sha256 $NPM_SHA"

# ── the DMG ────────────────────────────────────────────────────────────────

DMG="Email-Local-MCP-${VERSION}-universal.dmg"
DMG_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${DMG}"
say "fetching $DMG_URL"
if curl -fsSL "$DMG_URL" -o "$TMP/app.dmg"; then
  DMG_SHA="$(shasum -a 256 "$TMP/app.dmg" | cut -d' ' -f1)"
  say "  sha256 $DMG_SHA"
else
  DMG_SHA=""
  say "  not published yet; leaving the cask untouched"
fi

# ── stamp ──────────────────────────────────────────────────────────────────
#
# Rewrites are anchored to the whole line so a partial match cannot leave a
# formula that is half-updated and still syntactically valid.

stamp() { # file, key, value
  local file="$1" key="$2" value="$3"
  grep -qE "^ *${key} " "$file" || die "no ${key} line in $(basename "$file")"
  /usr/bin/sed -i '' -E "s|^( *${key} ).*|\1\"${value}\"|" "$file"
}

stamp "$FORMULA" "url" "https://registry.npmjs.org/${PKG}/-/${PKG}-${VERSION}.tgz"
stamp "$FORMULA" "sha256" "$NPM_SHA"
say "stamped Formula/email-local-mcp.rb -> $VERSION"

if [ -n "$DMG_SHA" ]; then
  stamp "$CASK" "version" "$VERSION"
  stamp "$CASK" "sha256" "$DMG_SHA"
  say "stamped Casks/email-local-mcp.rb -> $VERSION"
fi

# ── verify before publishing them ──────────────────────────────────────────

if command -v brew >/dev/null; then
  say "auditing"
  brew ruby -e 'nil' >/dev/null 2>&1 || true
  ruby -c "$FORMULA" >/dev/null || die "Formula is not valid Ruby"
  ruby -c "$CASK" >/dev/null || die "Cask is not valid Ruby"
  say "  syntax OK (run 'brew audit --strict' against the tap for the full check)"
fi

# ── copy into the tap ──────────────────────────────────────────────────────

if [ -n "$TAP" ]; then
  [ -d "$TAP" ] || die "no tap checkout at $TAP"
  mkdir -p "$TAP/Formula" "$TAP/Casks"
  cp "$FORMULA" "$TAP/Formula/"
  [ -n "$DMG_SHA" ] && cp "$CASK" "$TAP/Casks/"
  say "copied into $TAP"
  say "  review, then commit and push the tap yourself"
fi

say "done"
