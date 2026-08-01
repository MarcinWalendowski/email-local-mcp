#!/usr/bin/env bash
#
# One-line CLI/engine setup from a clean checkout.
#
#   Usage:  scripts/setup-cli.sh [--install-agents]
#
#     --install-agents   Also register the MCP server into detected agents
#                        (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf).
#
# Installs dependencies, builds the engine, and prints next steps. macOS/Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INSTALL_AGENTS="no"
for a in "$@"; do
  case "$a" in
    --install-agents) INSTALL_AGENTS="yes" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "setup-cli: unknown argument: $a" >&2; exit 2 ;;
  esac
done

node_hint() {
  case "$(uname -s)" in
    Darwin) echo "  Install Node 18+:  brew install node   (or https://nodejs.org)" ;;
    Linux)  echo "  Install Node 18+:  use your package manager, nvm, or https://nodejs.org" ;;
    *)      echo "  Install Node 18+:  https://nodejs.org" ;;
  esac
}

# 1. Node >= 18
if ! command -v node >/dev/null; then
  echo "Node.js not found." >&2; node_hint >&2; exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node $(node -v) is too old: Email Local MCP needs Node 18 or newer." >&2
  node_hint >&2; exit 1
fi
echo "✓ node $(node -v)"

# 2. Install deps (lockfile-exact when possible, else a plain install).
if [ -f package-lock.json ]; then
  npm ci || { echo "note: npm ci failed, falling back to npm install"; npm install; }
else
  npm install
fi

# 3. Build the engine.
npm run build

# 4. Optionally register into agents.
if [ "$INSTALL_AGENTS" = "yes" ]; then
  echo "==> registering MCP into detected agents"
  node dist/index.js install --all
fi

cat <<'EOF'

Setup complete. Next steps:
  node dist/index.js add you@example.com    # add an account (prompts for an App Password)
  node dist/index.js test                    # verify IMAP + SMTP login
  node dist/index.js install                 # register the server into your agents
  node dist/index.js list                    # list configured accounts

Run `node dist/index.js help` for the full command list.
EOF
