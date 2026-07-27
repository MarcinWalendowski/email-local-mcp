# Changelog

All notable changes to AnyMail MCP are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Sign in with OAuth, no App Password.** `anymail-mcp login <email>` connects a
  **Gmail** or **Microsoft 365 / Outlook** account through the provider's own
  sign-in page in your browser: authorization code + PKCE, a one-shot listener on
  `127.0.0.1`, and a refresh token stored in the same OS credential store App
  Passwords already use. Access tokens are refreshed automatically a minute
  before expiry, and `anymail-mcp logout <email>` disconnects, revoking at the
  provider where the provider offers an endpoint for it (Google does).
  This is what makes **Microsoft 365 / Outlook** work at all: basic auth for IMAP
  on Exchange Online is retired, so there is no App Password to create. Microsoft
  accounts join the folders/text-search feature set (no labels, no threads);
  Gmail over OAuth keeps everything it has today, labels and Gmail search syntax
  included.
  One piece of setup is yours: **you register the OAuth client and pass its id**.
  Mail scopes are "restricted", so a client id shipped inside a public binary
  would require this project to pass Google's verification plus an annual
  third-party security assessment, and until then would issue refresh tokens that
  expire every 7 days. A client you create has none of those limits.
  [docs/oauth.md](docs/oauth.md) walks through both providers; the design is
  [docs/specs/006-local-oauth.md](docs/specs/006-local-oauth.md).
  **Nothing changed for existing accounts.** An account added with `add` still
  authenticates with its App Password, with no migration and no behaviour change,
  and the MCP tool surface is byte-for-byte identical (`npm run surface`) — of
  this change; the surface did move later in this release, under *Tool
  descriptions now key on capability* in Changed.
- **`npm test`.** Node's built-in test runner over the pure logic, starting with
  the OAuth flow (PKCE against the RFC 7636 vector, callback and token-response
  parsing, endpoint construction, error text). No test framework added.
- **`anymail-core` — the tool layer, as a package.** The portable half of the
  engine (the ~25 MCP tool definitions, the `MailProvider` contract, and a new
  `MailHost` seam) now lives in `src/core/` and publishes to npm as
  [`anymail-core`](core/README.md). It contains no way to fetch mail: no IMAP, no
  filesystem, no credential store. That is the point — it lets a second, hosted
  deployment (provider REST APIs over per-user OAuth, no Mac involved) register
  **the same tools**, so the two cannot present different vocabularies to an
  agent.
  The line is enforced rather than remembered: `tsconfig.core.json` type-checks
  `src/core` with no `@types/node` and a WebWorker lib, so a `node:*` import,
  `process` or `Buffer` fails the build at the boundary. It runs as part of
  `npm run typecheck`, and so in CI on every push.
  **Nothing changed for this app.** The tool names, schemas, descriptions and
  server instructions are byte-for-byte what they were — verified by diffing the
  full surface (new: `npm run surface`) before and after, including from the
  built `dist/`. That holds for the split itself; the descriptions were reworded
  afterwards, under *Tool descriptions now key on capability* in Changed.
- **The app updates itself.** Sparkle 2 is built in: the app checks for updates on
  launch, every 6 hours, and whenever you open it (clicking the menu-bar icon or
  re-opening the app; throttled, and silent unless an update exists), then
  downloads and installs them automatically: the DMG you download is the last one
  you fetch by hand. A "Check for Updates… (v…)" item in the menu-bar menu
  triggers a manual check.
  Updates are EdDSA-signature-verified against a key pinned in the app, so only
  builds signed by the maintainer are ever installed (this holds even while the
  app itself is ad-hoc signed). The feed is `appcast.xml` on `main`; the update
  payloads are the normal release DMGs. Design: `docs/specs/005-auto-update.md`.
- **Downloadable universal DMG with a bundled Node runtime.** The menu-bar app now
  ships a pinned, universal (Apple Silicon + Intel) Node runtime and the built engine
  inside the `.app`, so it runs on any recent Mac with no Node and no Homebrew
  installed. The Swift launcher prefers this bundled runtime over a system Node, and
  falls back to a system Node only when the bundle is absent. Build it with a single
  command (`npm run app:dmg`), which produces `AnyMail-MCP-<version>-universal.dmg`.
  The DMG is ad-hoc signed for now (first launch needs the Gatekeeper "Open Anyway"
  path); the Developer ID signing and notarization pipeline is wired and switches on
  automatically once the maintainer supplies a certificate.
- **App icon.** A dedicated envelope mark (`assets/app-icon.svg`, rendered to
  `AppIcon.icns` by `scripts/make-icon.sh`), used as both the app icon and the DMG
  volume icon, in the same palette as the DMG background art.
- **One-line build and setup scripts.** `npm run setup` takes a clean checkout to a
  built CLI/engine (`scripts/setup-cli.sh`, with `--install-agents` to also register
  the server into detected agents); `npm run app:build` builds the app
  (`scripts/build-app.sh [--bundled]`); `npm run app:dmg` builds the universal DMG.
  A new `scripts/stage-engine.sh` assembles the self-contained engine payload
  (universal `node`, production deps, both keyring addons) and self-smoke-tests it.
- **`--show-add-account` launch flag** on the app: opens the Add Account window on
  launch, so UI QA and screenshots do not require clicking through the menu-bar item.
- **Windows and Linux support for the CLI and engine**: per-OS agent config paths,
  native credential-store naming, and a best-effort Windows ACL on the local token file.
- CI builds and runs a CLI smoke test on Ubuntu, macOS, and Windows, plus a native
  credential-store round-trip on macOS and Windows.
- **GitHub issue and PR templates**: a bug-report form and a feature-request form
  (with an "app or CLI?" field), a config that routes security reports to a private
  advisory, and a pull-request checklist (typecheck, changelog, docs, no secrets).

### Changed
- **Tool descriptions now key on capability, not on the provider's name — and
  `list_accounts` reports the capabilities.** Every account in `list_accounts`
  carries `capabilities: { labels, threads, nativeSearch }`, and the tools that
  used to say "Gmail only" or "on other providers" now point at the flag they
  actually depend on.

  The old wording collapsed three independent capabilities onto one Gmail-vs-rest
  axis, which was true of every provider this app shipped and stops being true the
  moment one lands in between: Microsoft Graph has no labels but does have
  server-side threads and a real query language, so the old prose told such an
  account that `get_thread` would not work and that its search syntax did not
  exist. Both false, from tools whose schemas were correct — the descriptions were
  the only thing wrong.

  Nothing an existing account can do changed; this is what the model is told about
  it. Gmail and IMAP accounts report exactly the capabilities they always had.
  This **is** a tool-surface change (the first in this release: the two
  "byte-for-byte identical" notes above describe the OAuth and `anymail-core`
  changes, which each moved nothing, and predate this one).
- **`ProviderId` gained `microsoft`**, for the Microsoft Graph implementation.
  Unused by this app, which reaches a Microsoft mailbox over IMAP/SMTP and
  registers it as `imap` — see [`anymail-core`](core/README.md).
- **`createDraft` returns an `id`.** The draft doctrine is draft → show the user →
  explicit yes → send *the draft that was shown*, and the contract gave the tool
  layer no handle to refer back to it. Nullable, because Gmail over IMAP genuinely
  cannot name its own draft (its ids are X-GM-MSGIDs; APPEND returns a UID), and a
  handle that does not resolve is worse than an honest null.
- **Source layout: `src/core/` and `src/node/`.** Everything Node-only moved under
  `src/node/` (`providers/`, `mcp/`, `http/`, `keychain.ts`, `registry.ts`,
  `cli.ts`, …); `src/index.ts` stays where it is, so the built entry point the app
  and the `bin` field both depend on is still `dist/index.js`. Only import paths
  changed — see [CONTRIBUTING](CONTRIBUTING.md#the-corenode-line).
- **Docs overhaul.** The README is restructured quickstart-first: the app download
  (DMG install + Gatekeeper steps) and the one-line CLI setup are now above the fold,
  with the reference material below. `DISTRIBUTION.md` moved to `docs/DISTRIBUTION.md`,
  and security / signing / notarization content is de-duplicated so each topic has a
  single owner doc.
- Credential-store error messages, CLI help, and `add_account` tool descriptions now
  name the platform's store (macOS Keychain / Windows Credential Manager / Linux
  Secret Service) instead of always saying "Keychain".
- **The app's "Create an App Password" assistant is now one copyable prompt.** It used
  to be a stack of buttons that copied a hidden, Gmail-only prompt and opened a specific
  vendor (Claude for Chrome / ChatGPT / Claude.ai). Now the prompt is shown in the window
  (truncated, scrollable, with a **Copy Prompt** button) and you paste it into whatever
  agent you already use, rather than one we picked for you. It's readable *before* you
  trust it with a credential.

  The prompt now also does the whole job: it tells the agent to create the App Password
  **and** register the account via the `add_account` MCP tool, so one paste finishes the
  setup with nothing to type back. It fills in from the email/provider/hosts in the form
  and is provider-aware: Gmail, iCloud, Fastmail and custom IMAP each get their own
  route and preconditions, where previously every prompt said "Gmail". The manual path
  (**Open <provider>'s page** → paste the code into the field) is unchanged and still the
  private one: the window notes inline that routing through an agent puts the password in
  the model's context and the client's logs.

### Fixed
- The Add Account window sizes itself to its content instead of two hardcoded heights,
  so showing the custom-IMAP fields or a long error can no longer clip it.
- `install --all` no longer writes a macOS `~/Library` config tree on Linux or Windows;
  Claude Desktop and VS Code configs resolve to the correct per-OS locations.

### Planned
- OAuth sign-in as an alternative to App Passwords.
- Microsoft 365 / Outlook provider (needs OAuth, since basic-auth IMAP is being retired).
- Developer ID signing + notarization of the DMG (the pipeline is wired; it needs the
  maintainer's certificate), then Homebrew distribution.
- `npm`/`npx` distribution for the CLI/engine.

## [0.0.1-rc.2] - 2026-07-15

### Changed — BREAKING
- **`gmMsgId` → `id`, `gmThrId` → `threadId`** across every tool's input and output.
  The engine serves iCloud, Fastmail and generic IMAP as well as Gmail, but the schema
  still named its ids after Gmail's `X-GM-MSGID` / `X-GM-THRID` — on a non-Gmail
  account the id is really folder+uidvalidity+uid. The fields were always documented
  as opaque and provider-defined; now they're named that way, matching what the code
  calls them internally and what Gmail's own API calls them.

  `get_message` and friends now take `{id}`; `get_thread` takes `{threadId}`. Note
  `id` is **not** `messageId` — the latter is still the RFC822 Message-ID header, and
  both appear on a message summary. Any agent that hardcoded the old field names must
  be updated; agents reading the schema each session need no change.

## [0.0.1-rc.1] - 2026-07-15

**First release candidate.** The earlier `v0.1.0`–`v0.3.0` tags and releases have been
withdrawn and the version reset: this project is pre-1.0, the public version history
restarts here, and interfaces may still change without notice. Everything below is the
current feature set, not a diff against a withdrawn build.

### Added
- **Multi-account, multi-provider email MCP engine** (Node/TypeScript), exposing full
  CRUD over IMAP/SMTP to any MCP client. One agent session can span several mailboxes
  across different providers; every tool takes an optional `account`.
- **Providers** — Gmail (labels, threads, native `X-GM-RAW` search) plus a generic
  IMAP/SMTP provider for **iCloud**, **Fastmail**, or any host
  (`--provider icloud|fastmail|imap`, with custom host/port). Non-Gmail accounts are
  folder-based: no labels, no server-side threads, text-only search. `list_accounts`
  reports each account's provider so an agent can tell which rules apply.
- **Per-message tools** — `list_accounts`, `search_messages`, `get_message`,
  `get_thread`, `list_labels`, `get_attachment`, `send_message`, `create_draft`,
  `create_label`, `modify_labels`, `mark_read`, `mark_unread`, `star`, `unstar`,
  `archive`, `move_message`, `trash_message`, `delete_message`, `add_account`.
- **Query-first bulk tools** — `mark_all_read`, `bulk_modify_labels`, `bulk_move`,
  `bulk_trash`, `bulk_delete`, `empty_spam`, `empty_trash`. Each takes
  `{query?, mailbox?, dryRun?, confirm?, max?}` and acts on the whole matching set in
  one pass instead of one call per message. `dryRun:true` previews the count and a
  sample; destructive or >100-message batches require `confirm:true`; partial failures
  are reported, never hidden. Spam and Trash are reachable via `mailbox`.
- **Resumable bulk** — removing ops (trash / move / delete / empty) act on up to `max`
  (default 2000) messages per call and return `{matched, affected, remaining, done}`;
  when `done:false`, re-run the same call to continue. Keeps a 10k-message sweep under
  the client's tool timeout.
- **Two transports from one engine** — stdio, and an always-on local HTTP server on
  `127.0.0.1:8765`.
- **CLI** for account management: `add`, `list`, `test`, `default`, `remove`,
  `install`, `token`. `install` registers the server into Claude Desktop, Claude Code,
  Cursor, VS Code and Windsurf.
- **macOS menu-bar app** (Swift/AppKit) — supervises the engine, with an Add Account
  window (provider picker + custom IMAP host/port), Install into Agents, and Start at
  Login. The App Password never reaches the model: it is posted to the local engine,
  which stores it in the Keychain.
- **"Create an App Password" assistant** in the app — opens the provider's page in your
  own browser, or hands the task to a local (Claude for Chrome) or cloud
  (ChatGPT / Claude.ai) agent. It never automates the provider's page itself; cloud
  options carry an inline full-mailbox exposure warning and are never the default.
- **Security** — App Passwords only in the macOS Keychain; loopback-only bind;
  bearer-token auth on every request; Origin validation (DNS-rebinding defense);
  per-account read-only mode; `confirm:true` gate on permanent delete; stderr logging
  with secret redaction.

### Note for anyone running a withdrawn 0.1–0.3 build
The stored identifiers were renamed from `gmail-mcp` to `anymail-mcp`, so an upgrade
will not find your existing accounts or App Passwords. To carry them over:

```bash
mv ~/.gmail-mcp ~/.anymail-mcp   # keeps accounts.json + your local server token
```

Then re-add each account (`anymail-mcp add <email>`) to write its App Password under
the new Keychain service, and delete the stale `gmail-mcp` entries in Keychain Access.
Gmail-specific names (`imap.gmail.com`, `[Gmail]/Spam`, the `X-GM-*` extensions) are
unrelated to this and unchanged.

[Unreleased]: https://github.com/MarcinWalendowski/anymail-mcp/compare/v0.0.1-rc.2...HEAD
[0.0.1-rc.1]: https://github.com/MarcinWalendowski/anymail-mcp/releases/tag/v0.0.1-rc.1
[0.0.1-rc.2]: https://github.com/MarcinWalendowski/anymail-mcp/compare/v0.0.1-rc.1...v0.0.1-rc.2
