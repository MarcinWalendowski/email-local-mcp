# Security

Email Local MCP runs entirely on your Mac and can read, send, and delete your mail, so
it is built to keep credentials on-device and the local server closed to
everything but your agent.

## Where credentials live

- **App Passwords** are stored **only in the macOS Keychain** (service
  `email-local-mcp`, keyed by email). They are never written to disk, never placed in
  environment variables that persist, never logged, and never returned in any
  API/tool response.
- **Non-secret account config** (which emails are connected, which is default,
  read-only flags) lives in `~/.email-local-mcp/accounts.json`.
- **The local server's bearer token** lives in `~/.email-local-mcp/server.json`
  (`0600`).

None of these are inside the repository, and `~/.email-local-mcp/` is ignored by git
as a belt-and-suspenders measure.

**Token file permissions.** On macOS and Linux the token file is written with
POSIX mode `0600`, so only your user account can read it. Windows ignores POSIX
mode bits, so after writing the file Email Local MCP applies a best-effort ACL
(`icacls <file> /inheritance:r /grant:r <you>:F`) that strips inherited
permissions and grants only your account access. That hardening is best-effort:
if it fails it is logged and never fatal, since the loopback bind and bearer
token remain the primary defenses. Be aware that until it succeeds, the token
file could be readable by other local users on that Windows machine.

## Local server hardening

- **Loopback only** — binds `127.0.0.1`; it never listens on a routable
  interface, so nothing off-machine can reach it.
- **Bearer token** required on every request, including the admin API.
- **Origin validation** rejects browser-style `Origin` headers (defends against
  DNS-rebinding from a malicious web page).
- **Permanent delete** requires an explicit `confirm: true`; `trash_message` is
  the reversible default.
- **Bulk operations are gated too** — the query-first bulk tools support
  `dryRun: true` to preview the exact matched count before touching anything, and
  destructive or large (>100-message) batches require `confirm: true`. Per-message
  failures are surfaced in the result rather than silently dropped.
- **Per-account read-only mode** refuses all write operations for accounts you
  only want to triage.

## Adding accounts keeps the password off the model

The most private way to connect an account is the app's **Add Account** window or
the **CLI** (`email-local-mcp add`): the App Password is posted straight to the local
engine and stored in the Keychain — the AI model never sees it.

The `add_account` **MCP tool** is a convenience for adding accounts from an agent,
but its `appPassword` argument is part of the tool call, so it passes through the
agent's context and the MCP client's logs. Prefer the GUI or CLI when you can, and
revoke-and-rotate the App Password if you ever add one through an agent you don't
fully control.

## App Password blast radius

A Gmail App Password grants **full, unscoped mailbox access** — there is no
per-scope limit. Treat it like a password:

- Use a **dedicated** App Password per machine so you can revoke narrowly.
- If a Mac is lost or compromised, revoke the App Password immediately at
  <https://myaccount.google.com/apppasswords>. That instantly cuts Email Local MCP off
  from the account, no matter what else is going on.
- Prefer **read-only** for accounts the agent only needs to search.

## Reporting a vulnerability

Please report security issues privately by opening a
[GitHub security advisory](https://github.com/MarcinWalendowski/email-local-mcp/security/advisories/new)
rather than a public issue. You'll get an acknowledgement as soon as possible.
