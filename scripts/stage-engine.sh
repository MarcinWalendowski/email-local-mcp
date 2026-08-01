#!/usr/bin/env bash
#
# Stage a self-contained, universal engine payload for bundling into the .app.
# Output: app/build/engine-staging/{bin/node, dist/, node_modules/, package.json}
#
#   Prereqs: node, npm, lipo, curl, shasum, tar (macOS + a Node install)
#   Usage:   scripts/stage-engine.sh
#   Env:     NODE_VERSION   pinned Node runtime (default 22.12.0)
#
# The bundled node is a universal (arm64 + x86_64) lipo of the official OpenJS
# darwin tarballs. We NEVER re-sign it here: the OpenJS Developer-ID signature
# and its JIT / library-validation entitlements must survive into the bundle.
# The x64 keyring addon is grafted in so the napi loader resolves on either arch.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.12.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${HOME}/Library/Caches/email-local-mcp-build"
STAGING="${ROOT}/app/build/engine-staging"
DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}"
ARM_TGZ="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
X64_TGZ="node-v${NODE_VERSION}-darwin-x64.tar.gz"

say() { printf '  %s\n' "$*"; }
die() { printf 'stage-engine: %s\n' "$*" >&2; exit 1; }

command -v lipo   >/dev/null || die "lipo not found (install Xcode command line tools)."
command -v npm    >/dev/null || die "npm not found."
command -v node   >/dev/null || die "node not found."
command -v curl   >/dev/null || die "curl not found."
command -v shasum >/dev/null || die "shasum not found."

CLEANUP=()
cleanup() { [ "${#CLEANUP[@]}" -gt 0 ] && rm -rf "${CLEANUP[@]}" || true; }
trap cleanup EXIT

mkdir -p "$CACHE"

echo "==> stage-engine (Node ${NODE_VERSION}, universal)"

# --- 1. Download + verify both Node tarballs -------------------------------
# SHASUMS is small + authoritative — always re-fetch.
curl -fsSL "${DIST_URL}/SHASUMS256.txt" -o "${CACHE}/SHASUMS256.txt" \
  || die "cannot fetch SHASUMS256.txt from ${DIST_URL}"

fetch_and_verify() {
  local file="$1" dest="${CACHE}/$1" want got
  want="$(grep " ${file}\$" "${CACHE}/SHASUMS256.txt" | awk '{print $1}')"
  [ -n "$want" ] || die "no checksum for ${file} in SHASUMS256.txt"
  if [ -f "$dest" ]; then
    got="$(shasum -a 256 "$dest" | awk '{print $1}')"
    if [ "$want" = "$got" ]; then say "cached + verified ${file}"; return; fi
    say "cache stale for ${file}, re-downloading"; rm -f "$dest"
  fi
  say "downloading ${file}"
  curl -fsSL "${DIST_URL}/${file}" -o "$dest" || die "download failed: ${DIST_URL}/${file}"
  got="$(shasum -a 256 "$dest" | awk '{print $1}')"
  [ "$want" = "$got" ] || { rm -f "$dest"; die "checksum mismatch for ${file} (want ${want}, got ${got})"; }
  say "verified ${file}"
}
fetch_and_verify "$ARM_TGZ"
fetch_and_verify "$X64_TGZ"

# --- 2. lipo the two node binaries into a universal bin/node ---------------
WORK="$(mktemp -d)"; CLEANUP+=("$WORK")
tar -xzf "${CACHE}/${ARM_TGZ}" -C "$WORK"
tar -xzf "${CACHE}/${X64_TGZ}" -C "$WORK"
ARM_NODE="${WORK}/node-v${NODE_VERSION}-darwin-arm64/bin/node"
X64_NODE="${WORK}/node-v${NODE_VERSION}-darwin-x64/bin/node"
[ -x "$ARM_NODE" ] && [ -x "$X64_NODE" ] || die "node binaries missing after extract"

rm -rf "$STAGING"
mkdir -p "$STAGING/bin"
lipo -create "$ARM_NODE" "$X64_NODE" -output "$STAGING/bin/node"
chmod +x "$STAGING/bin/node"

archs="$(lipo -archs "$STAGING/bin/node")"
case " $archs " in
  *" x86_64 "*) : ;; *) die "bin/node missing x86_64 (got: $archs)";;
esac
case " $archs " in
  *" arm64 "*) : ;; *) die "bin/node missing arm64 (got: $archs)";;
esac
say "universal node: $archs"

# The whole ad-hoc pipeline rests on this: lipo must preserve the OpenJS
# Developer-ID signature (it does — each slice keeps its own signature). Assert
# it here, at staging time, not after a full DMG. The first codesign read of a
# freshly-written large Mach-O can transiently fail its trust evaluation, so
# retry a few times before treating a missing TeamIdentifier as fatal.
sig_team() { codesign -dvvv "$1" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}'; }
team=""
for _ in 1 2 3 4 5; do
  team="$(sig_team "$STAGING/bin/node" || true)"
  [ "$team" = "HX7739G8FX" ] && break
  sleep 1
done
if [ "$team" = "HX7739G8FX" ]; then
  say "OpenJS signature intact (TeamIdentifier=HX7739G8FX)"
else
  say "codesign report for bin/node:"
  codesign -dvvv "$STAGING/bin/node" >&2 2>&1 || true
  die "could not confirm OpenJS TeamIdentifier=HX7739G8FX on bin/node (got '${team:-none}')"
fi

# --- 3. Production deps, installed in isolation ----------------------------
PAY="$(mktemp -d)"; CLEANUP+=("$PAY")
cp "${ROOT}/package.json" "${ROOT}/package-lock.json" "$PAY/"
say "npm ci --omit=dev --ignore-scripts"
( cd "$PAY" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 ) \
  || die "npm ci failed in isolation"

# --- 4. Graft the darwin-x64 keyring addon (version read from lockfile) -----
KEYRING_X64_VER="$(node -e "console.log(require('${ROOT}/package-lock.json').packages['node_modules/@napi-rs/keyring-darwin-x64'].version)")"
[ -n "$KEYRING_X64_VER" ] || die "cannot read @napi-rs/keyring-darwin-x64 version from lockfile"
say "grafting @napi-rs/keyring-darwin-x64@${KEYRING_X64_VER}"
PACKDIR="$(mktemp -d)"; CLEANUP+=("$PACKDIR")
( cd "$PACKDIR" && npm pack "@napi-rs/keyring-darwin-x64@${KEYRING_X64_VER}" >/dev/null 2>&1 ) \
  || die "npm pack of keyring-darwin-x64 failed"
X64_PKG_TGZ="$(ls "$PACKDIR"/*.tgz)"
X64_DEST="${PAY}/node_modules/@napi-rs/keyring-darwin-x64"
mkdir -p "$X64_DEST"
tar -xzf "$X64_PKG_TGZ" -C "$X64_DEST" --strip-components=1
[ -f "$X64_DEST/package.json" ] || die "keyring-darwin-x64 graft failed"

# --- 5. Prune node_modules -------------------------------------------------
# Docs, type decls (incl. .d.ts — not needed at runtime), source maps, tests.
find "${PAY}/node_modules" -type f \( -name '*.md' -o -name '*.ts' -o -name '*.map' \) -delete
find "${PAY}/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name .github \) \
  -prune -exec rm -rf {} +

# --- 6. Assemble the staging dir -------------------------------------------
if [ ! -f "${ROOT}/dist/index.js" ]; then
  say "dist/ missing, building engine"
  ( cd "$ROOT" && npm run build >/dev/null 2>&1 ) || die "npm run build failed"
fi
[ -f "${ROOT}/dist/index.js" ] || die "dist/index.js still missing after build"

cp -R "${ROOT}/dist"           "$STAGING/dist"
cp -R "${PAY}/node_modules"    "$STAGING/node_modules"
cp    "${ROOT}/package.json"   "$STAGING/package.json"
grep -q '"type"[[:space:]]*:[[:space:]]*"module"' "$STAGING/package.json" \
  || die "staged package.json is missing \"type\":\"module\" (ESM engine won't load)"

# --- 7. Smoke tests --------------------------------------------------------
say "smoke: engine 'help'"
"$STAGING/bin/node" "$STAGING/dist/index.js" help >/dev/null 2>&1 \
  || die "staged engine failed to run 'help'"

# Load the keyring addon (import only — never touches the real keychain).
say "smoke: keyring import"
( cd "$STAGING" && "$STAGING/bin/node" --input-type=module \
    -e "await import('@napi-rs/keyring'); process.stdout.write('ok')" >/dev/null 2>&1 ) \
  || die "staged node could not import @napi-rs/keyring"

MODULES_SIZE="$(du -sh "$STAGING/node_modules" | awk '{print $1}')"
TOTAL_SIZE="$(du -sh "$STAGING" | awk '{print $1}')"

cat <<EOF

stage-engine PASS
  node:     universal ($(lipo -archs "$STAGING/bin/node"))  signature=OpenJS HX7739G8FX
  engine:   ${STAGING}/dist/index.js
  modules:  ${MODULES_SIZE}
  total:    ${TOTAL_SIZE}
  staging:  ${STAGING}
EOF
