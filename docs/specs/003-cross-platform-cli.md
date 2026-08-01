# Cross-platform CLI (Windows and Linux)

Status: Accepted (implementation in progress, targeting v0.0.1-rc.3)

Grounded in the current code: `src/install.ts`, `src/keychain.ts`,
`src/server-config.ts`, `.github/workflows/ci.yml`. The menu-bar app stays
macOS-only (spec 001); this spec is about the CLI and engine, which are pure Node
and should run on Windows and Linux too.

## Problem

The engine is plain Node and mostly portable, but four things are macOS-only in
ways that break or mislead on other platforms:

1. **`src/install.ts` hardcodes macOS agent-config paths.** Both Claude Desktop
   and VS Code paths are built from `~/Library/Application Support/...`. On
   Linux or Windows, `install --all` would write a bogus `~/Library/...` tree
   that no agent reads.
2. **Keychain errors are macOS-shaped.** `src/keychain.ts` says "Keychain"
   everywhere, so on Linux, where there may be no Secret Service running at all,
   the user gets a confusing message with no guidance.
3. **The token file `chmod 0600` is a no-op on Windows.** `src/server-config.ts`
   writes `server.json` with mode `0600`, which POSIX honors but Windows
   ignores, leaving the local bearer token readable by other local users.
4. **SIGTERM handling is meaningless on Windows.** The supervisor relies on
   POSIX signal semantics that Windows does not provide.

## Design

### Per-OS agent config paths (`src/install.ts`)

Resolve each agent's config path from the current platform instead of a fixed
`Library/Application Support` join. The two affected agents:

**Claude Desktop**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `$XDG_CONFIG_HOME` (or `~/.config`) `/Claude/claude_desktop_config.json` |

**VS Code**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Code/User/mcp.json` |
| Windows | `%APPDATA%\Code\User\mcp.json` |
| Linux | `~/.config/Code/User/mcp.json` |

`%APPDATA%` is read from the environment, falling back to
`join(homedir(), "AppData", "Roaming")` when unset. The existing HTTP agents
(Cursor, Claude Code, Windsurf) already resolve from `homedir()` and need no
change. The `detected()` guard in `install.ts` still applies: never create
directories for an agent that is not detected on the current OS, so `--all` on
Linux writes nothing under a path that only exists on macOS.

### Credential-store naming and errors (`src/keychain.ts`)

`@napi-rs/keyring` already backs onto the platform's native store: macOS
Keychain, Windows Credential Manager, and Linux Secret Service. The code change
is to name the right store per platform in user-facing strings, and to make a
`setAppPassword` failure on Linux actionable. On Linux the common cause is that
no Secret Service is running, so the error explains that a running Secret
Service (gnome-keyring or KWallet) is required, with hints for headless setups
(for example, starting `gnome-keyring-daemon` under a dbus session, or that a
headless server may have no keyring at all).

### Windows token-file hardening (`src/server-config.ts`)

POSIX mode bits do not restrict access on Windows, so after writing the token
file, apply a Windows ACL on a best-effort basis:

```
icacls <server.json> /inheritance:r /grant:r "<user>:F"
```

This removes inherited permissions and grants only the current user full
control. It is wrapped in try/catch and logged on failure (never fatal, since
the loopback bind and bearer token are the primary defenses). Documented in
[`SECURITY.md`](../../SECURITY.md) alongside the existing `0600` note.

### Windows shutdown

SIGTERM registration stays (it is harmless), but the engine does not rely on it
on Windows. The effective stop path there is the supervisor or console close.
This is documented rather than worked around, since the app supervisor is
macOS-only and CLI users on Windows stop the process the normal way.

### CI matrix (`.github/workflows/ci.yml`)

Today CI runs typecheck and build on a single `ubuntu-latest` runner. Extend it
to a matrix over `ubuntu-latest`, `macos-latest`, and `windows-latest`, each
running `npm ci`, typecheck, build, and a CLI smoke test:

- `help`, `token`, and `list` against an empty registry. `token` exercises the
  per-OS token-file write (and the Windows ACL path); `list` and the install
  resolver exercise the per-OS config paths.

A keyring set/get/delete round-trip runs on the macOS and Windows runners with
dummy credentials, proving the native store integration on both. Known
limitation: the Linux keyring round-trip is NOT run in CI, because it needs a
Secret Service daemon plus a dbus session on the runner. That is documented as a
follow-up rather than a blocker.

## Verification

- CI matrix green on all three OSes (`npm ci`, typecheck, build, CLI smoke).
- Keyring set/get/delete round-trip green on the macOS and Windows runners.
- Manual: `install --all` on Linux creates nothing under a fake `~/Library`
  tree, and writes the Claude Desktop / VS Code configs only under the correct
  `~/.config` paths when those agents are detected.
- Manual (Windows): after `email-local-mcp token`, the `server.json` ACL grants only
  the current user (`icacls server.json` shows a single `<user>:(F)` entry with
  inheritance removed).
