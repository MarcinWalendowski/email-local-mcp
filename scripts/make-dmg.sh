#!/usr/bin/env bash
#
# Build a branded, notarizable DMG for Email Local MCP.
#
#   Prereqs:  brew install create-dmg librsvg
#   Usage:    scripts/make-dmg.sh ["path/to/Email Local MCP.app"] [output.dmg]
#             With no app path, builds a bundled universal app first
#             (scripts/build-app.sh --bundled --configuration Release).
#   Signing:  DEVELOPER_ID="Developer ID Application: NAME (TEAMID)" scripts/make-dmg.sh ...
#
# After this produces the DMG, notarize + staple it (see docs/DISTRIBUTION.md step 2).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/assets/dmg-background.svg"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo dev)"

command -v create-dmg >/dev/null || { echo "Install create-dmg:  brew install create-dmg"; exit 1; }

# App path: given as $1, or build a self-contained universal app now.
APP="${1:-}"
if [ -z "$APP" ]; then
  echo "note: no app path given, building a bundled universal app..." >&2
  APP="$("$ROOT/scripts/build-app.sh" --bundled --configuration Release | tail -n 1)"
fi
[ -d "$APP" ] || { echo "Not an .app bundle: $APP"; exit 1; }

OUT="${2:-Email-Local-MCP-${VERSION}-universal.dmg}"
APP_NAME="$(basename "$APP")"
BG_DIR="$(mktemp -d)"
BG=""

# Rasterize the SVG background at @1x + @2x and combine them into a single
# multi-representation TIFF, so Finder shows a crisp image on retina displays
# (a bare @1x PNG gets pixel-doubled and looks blurry).
if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 600  -h 400 "$SVG" -o "$BG_DIR/background.png"
  rsvg-convert -w 1200 -h 800 "$SVG" -o "$BG_DIR/background@2x.png"
  BG="$BG_DIR/background.tiff"
  tiffutil -cathidpicheck "$BG_DIR/background.png" "$BG_DIR/background@2x.png" -out "$BG"
else
  echo "note: rsvg-convert not found (brew install librsvg); building a plain DMG background."
fi

rm -f "$OUT"

ARGS=(
  --volname "Email Local MCP"
  --window-pos 200 120
  # create-dmg window-size includes the ~28pt title bar, so 600x428 gives a
  # 600x400 content area that matches the background art exactly (600x400
  # here would crop the bottom 28px of the art).
  --window-size 600 428
  --icon-size 112
  --icon "$APP_NAME" 150 190
  --app-drop-link 450 190
  --hide-extension "$APP_NAME"
  --no-internet-enable
)
[ -n "$BG" ] && ARGS+=( --background "$BG" )

ICNS="$APP/Contents/Resources/AppIcon.icns"
[ -f "$ICNS" ] && ARGS+=( --volicon "$ICNS" )

# Optionally codesign the DMG itself (the .app should already be signed).
[ -n "${DEVELOPER_ID:-}" ] && ARGS+=( --codesign "$DEVELOPER_ID" )

create-dmg "${ARGS[@]}" "$OUT" "$APP"

SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo "→ $OUT (${SIZE})"
echo "Next: xcrun notarytool submit \"$OUT\" --wait  &&  xcrun stapler staple \"$OUT\"  (see docs/DISTRIBUTION.md)."
