# Contributing to Email Local MCP

Thanks for your interest! Email Local MCP is a local MCP server that connects multiple
email accounts to an MCP-capable agent. The CLI and engine run on macOS, Windows,
and Linux; the menu-bar app is macOS-only. Issues and pull requests are welcome.

## Project layout

```
src/
  index.ts        # engine entry (builds to dist/index.js — the app and `bin` both
                  #   point at that path, so this file stays put)
  core/           # PORTABLE — published as the `email-local-core` npm package
    tools.ts      #   the tool vocabulary: names, schemas, descriptions
    provider.ts   #   the MailProvider contract + its data types
    accounts.ts   #   the MailHost seam a deployment implements
    result.ts     #   the ok()/fail() tool-result shape
  node/           # NODE-ONLY — this app: IMAP/SMTP, the Keychain, the filesystem
    providers/    #   per-provider IMAP/SMTP: gmail.ts extends imap.ts
    oauth/        #   local sign-in: PKCE, loopback redirect, token refresh
    mcp/          #   MCP server wiring (stdio) + the deployment's instructions
    http/         #   always-on local HTTP + admin API
    host.ts       #   the local MailHost: registry + keychain + providers
    credential.ts #   how a provider authenticates: App Password or bearer token
    keychain.ts   #   OS credential store (Keychain / Credential Manager / Secret Service)
    install.ts    #   per-OS agent-config install (Claude Desktop, VS Code, ...)
    cli.ts        #   add / list / test / install / ...
core/             # the email-local-core package (package.json + README; dist is built)
app/              # macOS menu-bar app (Swift/AppKit), see app/BUILD.md
```

The engine holds **all** mail and Keychain logic; the Swift app is a thin shell
that talks to the engine's admin API over `127.0.0.1`.

### The core/node line

`src/core` must run unchanged in a V8 isolate (Cloudflare Workers, Deno) as well
as on Node, because a second, hosted deployment registers the same tools from it
— that is what stops the two tool surfaces from drifting. So **nothing in
`src/core` may touch a Node API**: no `node:*` import, no `process`, no `Buffer`.

That rule is enforced, not remembered. `tsconfig.core.json` type-checks the
directory with `"types": []` (no `@types/node`) and a WebWorker lib, so a Node
import fails the build at the boundary rather than surfacing later as a runtime
error somewhere it is much harder to explain. It runs as part of `npm run
typecheck`, and therefore in CI on every push.

Anything host-specific — which accounts exist, where credentials live, how a
provider is built — reaches the tool layer through the `MailHost` interface in
`src/core/accounts.ts`. If you find yourself wanting a Node API inside `core`,
that is the signal it belongs behind that seam instead.

## Developing the engine

```bash
npm install
npm run build       # tsc → dist/
npm run build:core  # tsc -p tsconfig.core.json → core/dist (the npm package)
npm run typecheck   # the app AND the no-Node-types core gate
npm run dev         # tsx src/index.ts (no build step)
npm run surface     # dump the MCP tool surface as canonical JSON
```

`npm run surface` is how a change to the tool layer is proved harmless: capture
it before, capture it after, `diff`. The tool names, schemas and descriptions are
a contract with every agent using this server.

`npm test` runs Node's built-in test runner over the pure logic (currently the
OAuth flow: PKCE, callback and token parsing, endpoint construction). There is no
test framework installed and none is wanted for functions like these. Anything
touching mail still needs a real account and credential, so there is no automated
mail suite; if you add tests that need credentials, keep them opt-in.

Tests live beside their subject as `*.test.ts`. They are excluded from `dist/`
(so they never ship inside the app) and type-checked separately by
`tsconfig.test.json`, which `npm run typecheck` runs.

Before opening a PR:

- `npm run typecheck` must pass.
- Never commit secrets. Account config and the server token live in
  `~/.email-local-mcp/` (outside the repo); App Passwords live in the Keychain. See
  [SECURITY.md](SECURITY.md).

## Good first contributions

The [roadmap in the README](README.md#roadmap) is the priority list. The biggest
open piece is **richer IMAP search** (mapping the common Gmail-style operators
onto IMAP SEARCH so non-Gmail accounts behave the same). Generic IMAP (iCloud,
Fastmail, any host) already shipped, and so has [OAuth sign-in](docs/oauth.md),
which brought Microsoft 365 / Outlook with it — a **sign-in button in the app**,
so OAuth does not require the CLI, is the natural follow-on. Smaller wins: better
error messages, additional agent install targets, docs.

## Code style

Match the surrounding code. TypeScript is `strict`; keep secrets out of logs
(pino redaction is already configured) and out of tool/API responses.
