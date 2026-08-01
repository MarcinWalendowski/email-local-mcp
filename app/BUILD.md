# Email Local MCP, menu-bar app

A thin Swift/AppKit menu-bar app over the Node engine in `../`. It:

- supervises the always-on engine (`node dist/index.js --http`),
- gives you a GUI to **connect mail accounts** (Gmail, iCloud, Fastmail, or a custom
  IMAP host, posted to the engine's admin API),
- **Install into Agents** (posts to `/admin/install`),
- **Start at Login** via `SMAppService`.

All mail/Keychain logic stays in the Node engine. When you add an account through the
form, the app never sees the App Password in a way any model can: it posts it once to
`127.0.0.1`, and the engine stores it in the Keychain.

## Prerequisites

- macOS 13+ and **Xcode 15+**.
- **XcodeGen**: `brew install xcodegen`.
- For a plain dev build, **Node 18+** on the machine (Homebrew
  `/opt/homebrew/bin/node` or `/usr/local/bin/node` are auto-detected; nvm too).
- For a self-contained DMG, also `brew install create-dmg librsvg` (the DMG bundles
  its own Node, so the machine running the app does not need one).

## Build & run (dev)

The one-command dev build (no engine bundling, uses your system Node, fast):

```bash
npm run app:build          # scripts/build-app.sh: xcodegen generate + xcodebuild + open
```

Or step through it by hand:

```bash
cd app
xcodegen generate          # → EmailLocalMCP.xcodeproj
open EmailLocalMCP.xcodeproj   # set your Signing Team (Signing & Capabilities), then Run
```

On launch a mail icon appears in the menu bar. Use **Add Account**, then **Install
into Agents**, then toggle **Start at Login**. Pass `--show-add-account` to open the
Add Account window immediately on launch (handy for UI QA and screenshots):

```bash
open "build/Build/Products/Release/Email Local MCP.app" --args --show-add-account
```

## Build the self-contained app + DMG

A `--bundled` build ships everything the engine needs **inside** the `.app`, so it
runs on a Mac with no Node and no Homebrew. This is what end users download.

```bash
npm run app:dmg            # scripts/make-dmg.sh: bundled universal build → Email-Local-MCP-<version>-universal.dmg
```

What that chains together:

| Script | npm alias | Does |
|--------|-----------|------|
| `scripts/setup-cli.sh [--install-agents]` | `npm run setup` | Clean checkout → built CLI/engine (`npm ci` + `npm run build`); `--install-agents` also registers the server into detected agents. |
| `scripts/stage-engine.sh` | | Assembles the bundled engine payload: a universal (`arm64` + `x86_64`) `bin/node` from the two official Node tarballs, production-only `node_modules`, both `@napi-rs/keyring` arch addons, and a `package.json` with `"type":"module"`. Self-smoke-tests the result. |
| `scripts/build-app.sh [--bundled] [--configuration Release\|Debug] [--open]` | `npm run app:build` | Builds the `.app`. Plain: a fast dev build (no staging, system Node). `--bundled`: runs `stage-engine.sh`, then a universal `xcodebuild` that copies the staging into `Contents/Resources/engine`. Prints the built `.app` path as its last line. |
| `scripts/make-dmg.sh ["Email Local MCP.app"]` | `npm run app:dmg` | Lays out the branded DMG (app icon, drag-to-Applications link, background). With no app path it runs `build-app.sh --bundled` first. Output: `Email-Local-MCP-<version>-universal.dmg`. |
| `scripts/make-icon.sh` | | Regenerates `app/EmailLocalMCP/AppIcon.icns` from `assets/app-icon.svg`. |

`npm run app:dmg` with `DEVELOPER_ID` set switches onto the Developer ID sign +
notarization path with no code change. The full pipeline and signing rationale are in
[`../docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md).

### App icon

`app/EmailLocalMCP/AppIcon.icns` is **committed**, so a contributor without librsvg can
build the app as-is. It is generated from `assets/app-icon.svg` by
`scripts/make-icon.sh` (which needs `librsvg` for `rsvg-convert`); run that only when
the icon art changes.

## The Add Account window

Two ways to get an App Password, both under the form:

- **Do it yourself**: opens the provider's page; paste the code into the field. The
  password goes straight to the local engine and into the Keychain, so no model ever
  sees it.
- **Copy Prompt**: one prompt you paste into any agent. It creates the App Password
  *and* registers the account with the `add_account` MCP tool, so nothing has to be
  typed back. The trade is privacy: the password becomes a tool-call argument, so it
  passes through the model's context and the client's logs. The window says so inline.

The app never automates a provider's page itself.

`AppPasswordPrompt` is deliberately pure and AppKit-free, so the prompt can be checked
without opening the window:

```bash
cd app
cat > /tmp/pp.swift <<'EOF'
for p in ["gmail", "icloud", "fastmail", "imap"] {
    print(AppPasswordPrompt.text(provider: p, email: "you@example.com"), "\n")
}
EOF
mv /tmp/pp.swift /tmp/main.swift
swiftc EmailLocalMCP/AppPasswordPrompt.swift /tmp/main.swift -o /tmp/promptcheck && /tmp/promptcheck
```

(Top-level statements only compile in a file named `main.swift`, hence the `mv`.)

## Paths

The app finds the engine at (in order): the bundled `Resources/engine/dist/index.js`,
an override, or `~/loki-labs/email-local-mcp/dist/index.js` (the dev checkout). Node is
found at (in order): a `nodePath` override, the bundled `Resources/engine/bin/node`,
then system Nodes. To override either for a dev build:

```bash
defaults write com.lokilabs.EmailLocalMCP nodePath   /opt/homebrew/bin/node
defaults write com.lokilabs.EmailLocalMCP enginePath /ABS/PATH/email-local-mcp/dist/index.js
```

## Notes & caveats

- **Dev vs bundled build.** A plain build uses your system Node against the engine
  checkout (which has `node_modules`); a `--bundled` build carries its own universal
  Node and production deps inside the `.app` and prefers them over any system Node.
- **Keychain prompt:** the first mail operation triggers "node wants to use your
  keychain", click **Always Allow**. Under ad-hoc signing it re-prompts once after
  each app update (the signing identity changes with the binary); a Developer ID
  signature makes it stable across releases.
- **Run-at-login** (`SMAppService`) needs the app in `/Applications` so the
  registration persists.
- **Not sandboxed** (it spawns node and writes agent configs). For distribution,
  codesign with your **Developer ID** and **notarize** (done on your machine; it can't
  be done in the coding-agent environment). See [`../docs/DISTRIBUTION.md`](../docs/DISTRIBUTION.md).
- Don't also run `node dist/index.js --http` by hand while the app is running; they'd
  both try to bind port 8765.
