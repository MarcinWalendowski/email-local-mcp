#!/usr/bin/env bash
#
# Render assets/app-icon.svg into app/EmailLocalMCP/AppIcon.icns.
#
#   Prereqs: brew install librsvg   (rsvg-convert) + iconutil (Xcode CLT)
#   Usage:   scripts/make-icon.sh
#
# The .icns is committed, so contributors without librsvg can still build the
# app; re-run this only when the icon art changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="${ROOT}/assets/app-icon.svg"
OUT="${ROOT}/app/EmailLocalMCP/AppIcon.icns"

command -v rsvg-convert >/dev/null || { echo "Install librsvg:  brew install librsvg"; exit 1; }
command -v iconutil     >/dev/null || { echo "iconutil not found (Xcode command line tools)."; exit 1; }
[ -f "$SVG" ] || { echo "Missing $SVG"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SET="${TMP}/AppIcon.iconset"; mkdir -p "$SET"

render() { rsvg-convert -w "$2" -h "$2" "$SVG" -o "${SET}/$1"; }
# iconutil naming: 64 is 32@2x, 1024 is 512@2x (no standalone 64 / 1024 entries).
render icon_16x16.png        16
render icon_16x16@2x.png      32
render icon_32x32.png         32
render icon_32x32@2x.png      64
render icon_128x128.png      128
render icon_128x128@2x.png   256
render icon_256x256.png      256
render icon_256x256@2x.png   512
render icon_512x512.png      512
render icon_512x512@2x.png  1024

iconutil -c icns "$SET" -o "$OUT"
echo "→ $OUT ($(du -h "$OUT" | awk '{print $1}'))"
