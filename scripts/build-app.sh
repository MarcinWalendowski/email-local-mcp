#!/usr/bin/env bash
#
# Build the Email Local MCP menu-bar app.
#
#   Usage:  scripts/build-app.sh [--bundled] [--configuration Release|Debug] [--open]
#
#     --bundled          Stage + bundle a self-contained universal engine, and
#                        build universal (arm64 + x86_64). Without it, a plain
#                        dev build: fast, active-arch only, no engine.
#     --configuration    Release (default) or Debug.
#     --open             Open the built app when done (not used by CI).
#
#   Signing: with DEVELOPER_ID set, re-signs inside-out (addons, then bin/node
#   with engine.entitlements, then the app last). Without it, the ad-hoc
#   signature Xcode applies is left untouched (the OpenJS-signed node is kept).
#
# Contract: the ONLY thing printed to stdout is the absolute .app path, as the
# last line. All human/progress output goes to stderr, so make-dmg.sh (or CI)
# can capture the path with `... | tail -n 1`.
set -euo pipefail

CONFIG="Release"
BUNDLED="no"
OPEN="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --bundled)        BUNDLED="yes" ;;
    --configuration)  CONFIG="${2:?--configuration needs a value}"; shift ;;
    --open)           OPEN="yes" ;;
    -h|--help)        sed -n '2,20p' "$0" >&2; exit 0 ;;
    *) echo "build-app: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="${ROOT}/app"
DD="${APPDIR}/build/DerivedData"
SCHEME="EmailLocalMCP"

log() { printf '%s\n' "$*" >&2; }

command -v xcodegen   >/dev/null || { log "xcodegen not found (brew install xcodegen)."; exit 1; }
command -v xcodebuild >/dev/null || { log "xcodebuild not found (install Xcode)."; exit 1; }
if [ "$BUNDLED" = "yes" ]; then
  command -v node >/dev/null || { log "node required for --bundled."; exit 1; }
  command -v npm  >/dev/null || { log "npm required for --bundled."; exit 1; }
fi

log "==> xcodegen generate"
( cd "$APPDIR" && xcodegen generate >&2 )

EXTRA=()
if [ "$BUNDLED" = "yes" ]; then
  log "==> staging engine"
  "${ROOT}/scripts/stage-engine.sh" >&2
  EXTRA=( BUNDLE_ENGINE=YES ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO )
fi

log "==> xcodebuild (${CONFIG}, bundled=${BUNDLED})"
( cd "$APPDIR" && xcodebuild \
    -project EmailLocalMCP.xcodeproj \
    -scheme "$SCHEME" \
    -configuration "$CONFIG" \
    -derivedDataPath "$DD" \
    ${EXTRA[@]+"${EXTRA[@]}"} \
    build >&2 )

APP="${DD}/Build/Products/${CONFIG}/Email Local MCP.app"
[ -d "$APP" ] || { log "build produced no app at: $APP"; exit 1; }
MAIN_BIN="${APP}/Contents/MacOS/Email Local MCP"
ENG="${APP}/Contents/Resources/engine"

is_universal() {
  local a; a="$(lipo -archs "$1" 2>/dev/null || true)"
  case " $a " in *" x86_64 "*) case " $a " in *" arm64 "*) return 0;; esac;; esac
  return 1
}

# --- Developer ID inside-out re-sign (only when DEVELOPER_ID is set) --------
if [ -n "${DEVELOPER_ID:-}" ]; then
  log "==> DEVELOPER_ID set: inside-out re-sign (no --deep)"
  if [ -d "$ENG" ]; then
    while IFS= read -r -d '' addon; do
      log "    sign addon: ${addon#$APP/}"
      codesign --force --timestamp --options runtime --sign "$DEVELOPER_ID" "$addon" >&2
    done < <(find "$ENG" -name '*.node' -print0)
    log "    sign engine bin/node (engine.entitlements)"
    codesign --force --timestamp --options runtime \
      --entitlements "${APPDIR}/EmailLocalMCP/engine.entitlements" \
      --sign "$DEVELOPER_ID" "${ENG}/bin/node" >&2
  fi
  # Sparkle ships XPC services and helper apps inside the framework; Sparkle's
  # documented re-sign order is those first, then the framework, then the app.
  SPARKLE="${APP}/Contents/Frameworks/Sparkle.framework"
  if [ -d "$SPARKLE" ]; then
    log "    sign Sparkle.framework internals"
    codesign --force --timestamp --options runtime --preserve-metadata=entitlements \
      --sign "$DEVELOPER_ID" "${SPARKLE}/Versions/B/XPCServices/Downloader.xpc" >&2
    codesign --force --timestamp --options runtime \
      --sign "$DEVELOPER_ID" "${SPARKLE}/Versions/B/XPCServices/Installer.xpc" >&2
    codesign --force --timestamp --options runtime \
      --sign "$DEVELOPER_ID" "${SPARKLE}/Versions/B/Autoupdate" >&2
    codesign --force --timestamp --options runtime \
      --sign "$DEVELOPER_ID" "${SPARKLE}/Versions/B/Updater.app" >&2
    codesign --force --timestamp --options runtime \
      --sign "$DEVELOPER_ID" "$SPARKLE" >&2
  fi
  log "    sign app (last)"
  codesign --force --timestamp --options runtime \
    --entitlements "${APPDIR}/EmailLocalMCP/EmailLocalMCP.entitlements" \
    --sign "$DEVELOPER_ID" "$APP" >&2
fi

# --- Verify ----------------------------------------------------------------
log "==> verify: codesign --verify --deep --strict"
codesign --verify --deep --strict "$APP" >&2

if [ "$BUNDLED" = "yes" ]; then
  [ -d "$ENG" ]                || { log "bundled build but no engine at $ENG"; exit 1; }
  [ -f "${ENG}/dist/index.js" ] || { log "bundled engine missing dist/index.js"; exit 1; }
  [ -x "${ENG}/bin/node" ]      || { log "bundled engine missing bin/node"; exit 1; }
  is_universal "$MAIN_BIN"      || { log "app main binary is not universal"; exit 1; }
  is_universal "${ENG}/bin/node" || { log "bundled node is not universal"; exit 1; }
  log "    app archs:  $(lipo -archs "$MAIN_BIN")"
  log "    node archs: $(lipo -archs "${ENG}/bin/node")"
  if [ -z "${DEVELOPER_ID:-}" ]; then
    # codesign trust evaluation on the 200MB+ universal node is transiently
    # flaky right after the copy phase (same behavior as in stage-engine.sh),
    # so retry before treating a missing TeamIdentifier as fatal.
    team=""
    for _ in 1 2 3 4 5; do
      team="$(codesign -dvvv "${ENG}/bin/node" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
      [ "$team" = "HX7739G8FX" ] && break
      sleep 1
    done
    if [ "$team" = "HX7739G8FX" ]; then
      log "    OpenJS signature intact on bundled node (ad-hoc path)"
    else
      log "bundled node lost OpenJS TeamIdentifier=HX7739G8FX (got '${team:-none}')"; exit 1
    fi
  fi
fi

if [ "$OPEN" = "yes" ]; then open "$APP" >&2 || true; fi

log "==> built: $APP"
printf '%s\n' "$APP"
