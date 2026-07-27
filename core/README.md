# anymail-core

The portable half of [AnyMail MCP](https://github.com/MarcinWalendowski/anymail-mcp):
the email **tool vocabulary** (~25 MCP tools with their schemas and
descriptions), the `MailProvider` contract every backend implements, and the
`MailHost` seam a deployment plugs into.

It contains no way to actually fetch mail. No IMAP, no HTTP client, no
filesystem, no credential store — those belong to whoever is hosting it. It
type-checks with **no `@types/node`** and a Workers lib, so it runs unchanged on
Node and in a V8 isolate (Cloudflare Workers, Deno).

## Why it is a package

The tool names are a contract. AnyMail runs in two places — a local macOS app
speaking IMAP/SMTP with App Passwords in the Keychain, and a hosted Worker
speaking provider REST APIs over per-user OAuth — and an agent must not be able
to tell them apart. Publishing the vocabulary makes that identity structural:
both hosts call the same `registerTools`, so the surfaces cannot drift without
someone changing this package on purpose.

## Usage

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildInstructions, registerTools, type MailHost } from "anymail-core";

const host: MailHost = {
  listAccounts: async () => [...],          // what `list_accounts` reports
  resolveEmail: async (account) => "...",   // optional arg -> an address
  assertWritable: async (email) => {},      // throw to refuse writes
  getProvider: async (email) => provider,   // a MailProvider for that address
  // accountAdmin is optional: supply it only if this deployment owns a
  // credential store to put a password in. Omitting it means `add_account`
  // is not registered at all, rather than registered and broken.
};

const server = new McpServer(
  { name: "my-mail", version: "1.0.0" },
  { instructions: buildInstructions("What this deployment connects to.") },
);
registerTools(server, host);
```

`@modelcontextprotocol/sdk` and `zod` are **peer** dependencies on purpose: the
host owns the `McpServer` instance, so both sides must resolve the same copy.

## Implementing a provider

`MailProvider` is ~25 methods over read / create / update / delete plus the
query-first bulk operations. `ProviderCapabilities` (`labels`, `threads`,
`nativeSearch`) is how a backend says what it cannot do, so the tool layer never
assumes Gmail: `bulk_modify_labels` throws on a folder-only backend and points
the caller at `bulk_move`, with no branch in the tools themselves.

The three flags are **independent**, and the tool descriptions name the flag they
depend on rather than a provider. Do not treat them as a Gmail-vs-rest switch:
Microsoft Graph is `labels: false` with `threads: true` and `nativeSearch: true`,
and it is your host's `listAccounts` that reports them — `AccountSummary` carries
`capabilities`, which is where every one of those descriptions sends the agent to
look. `ProviderId` names the service and is informational; the same Microsoft
mailbox is a folder store over IMAP and a threaded, searchable one over Graph, so
it can never stand in for the flags.

## Source

The sources live in [`src/core/`](../src/core) of the main repository; this
directory is the published package (build output lands in `core/dist`). Build it
from the repo root with `npm run build:core`, and pack it with
`npm run pack:core`.

## License

MIT — see the [repository LICENSE](../LICENSE).
