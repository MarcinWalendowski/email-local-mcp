# `src/hosted` — not part of the local app

Nothing in this directory ships. It is excluded from `tsconfig.json`, so it
cannot reach `dist/`, the npm tarball, or the `.app`. That exclusion is the
point, not an oversight.

## Why it is kept out

Email Local MCP sells one guarantee: **your mail never leaves your machine.**
`src/node/` earns it by opening IMAP and SMTP from the user's own computer to
the user's own mail host.

The code here does the opposite. A Composio-backed account's mail is fetched and
sent by **Composio's servers**, because Composio never releases the OAuth access
token it holds (verified against the live v3 API: `access_token`,
`refresh_token`, `id_token` and `headers.Authorization` all return the literal
string `"REDACTED"`). There is no version of this that runs locally.

Shipping it inside the local app would not have added a mode. It would have made
the product's central claim false for some accounts and true for others, with
nothing on the outside of the app to tell them apart, and every existing surface
still stating the absolute. The fix is not better wording. It is that the local
app does not contain this.

## What it is for

A hosted deployment — a Worker, sharing the same engine through
`email-local-core`. There, "mail is handled by our servers" is what the user
signed up for, so the same code is honest.

`src/core/accounts.ts` already anticipated the split: *"a hosted deployment
connects an account by sending the user through a provider consent screen… This
is the one place the two hosts legitimately differ."* This is that place.

## Rules for anything added here

1. **No import from `src/node/`, and no Node built-in.** The target is a V8
   isolate: no filesystem, no OS credential store, no `process.env`. Enforced by
   `tsconfig.hosted.json` (`types: []`, `lib: WebWorker`) — the root build has
   `@types/node` loaded and will happily accept `node:fs`, so this is the config
   that decides.
2. **Config is injected, never looked up.** `ComposioConfig` is passed in.
   Reaching for a credential is how the first version of `client.ts` became
   node-only without anyone noticing.
3. **`src/core` is the only shared code.** Anything both hosts need moves to
   core rather than being copied; two definitions of Gmail's capabilities is how
   `list_accounts` starts describing a mailbox the live provider cannot honour.
4. **`npm run typecheck` covers this directory and `npm test` runs its tests.**
   Excluded from the build is not excluded from the gates — unbuilt code rots,
   and the day the hosted host is built is the worst day to find out.
