# SPEC-007 — Composio: groundwork for a hosted host, not a local mode

**Status:** Built, deliberately not shipped locally. Lives in `src/hosted/`,
excluded from the local build.
**Date:** 2026-08-01 (scope reversed the same day — see "Why this is not a local
mode" below)

## TLDR

Adopting an OAuth connection the user already has in Composio removes the only
irreducible friction in `login`: you must register your own Google OAuth client.
It costs the local-only guarantee, because Composio will not release the token
and therefore fetches and sends that account's mail from its own servers.

**That cost is not payable by a product whose one claim is that mail never leaves
your machine**, so this is not a third mode of the local app. The provider is
implemented and tested, and it lives under `src/hosted/` for the hosted
deployment (SPEC-287's second host), where "our servers handle your mail" is what
the user signed up for. The local app is unchanged: two auth modes, and the
absolute claim intact.

## Problem

There are two ways to connect a mailbox and both ask something of the user:

- `add` needs an **App Password**, which Google increasingly hides and some
  workspaces disable outright.
- `login` needs an **OAuth client you register yourself**. Mail scopes are
  "restricted", so a client id shipped in a public binary would drag this project
  through Google verification and an annual security assessment, and until it
  passed, every user's refresh token would expire weekly. Registering your own
  takes about five minutes and is the single most common place people stop.

Composio has already paid the verification cost. A user who has connected Gmail
there has a working, verified OAuth grant sitting idle.

## The finding that shaped the design

**Composio will not release the token.** Verified against the live v3 API on an
ACTIVE Gmail connection: `access_token`, `refresh_token`, `id_token`, and
`headers.Authorization` all return the literal four-character string
`"REDACTED"`. The connection genuinely holds `https://mail.google.com/`, so the
capability exists; it is simply never handed out.

This killed the design we wanted: let Composio run the OAuth dance, take the
token, keep opening IMAP/SMTP locally, and change nothing about the trust model.
It is recorded here so the next person does not spend an afternoon rediscovering
it.

**Do not treat this as a setting waiting to be switched on.** An earlier draft of
this spec said to ask Composio whether "org-level raw credential access" could be
enabled, on the assumption that a yes would delete `ComposioGmailProvider`. That
was reasoning from how SaaS vendors usually gate features, not from anything
observed, and it is wrong twice over:

1. No such setting was ever found. The redaction was verified; the remedy was
   invented.
2. It would not help if it existed. The token is issued to **Composio's**
   `client_id`, and that client is what carries Google's verification and annual
   CASA assessment for restricted mail scopes. A token issued to it, used from
   this binary, would put our code under their verification and their liability.
   Declining that is the right call on their side, and no toggle changes it.
   Withholding credentials is close to the whole product for a credential broker.

The trade is therefore inherent, not a gap. The only route to a verified client
with locally-handled mail is to pay for Google verification ourselves, which is
precisely what the Problem section explains we are not doing.

## Why this is not a local mode

The first implementation shipped it as one: a `connect` verb, a third segment in
the macOS Add Account window, an inline warning at the moment of choosing, and
`list_accounts` reporting `mailHandledLocally` per account. Every surface that
made an absolute local-only claim — README, SECURITY.md, the landing page — was
rewritten to state it conditionally, and a check was added to *ban* the absolute
phrasing.

That was the wrong shape, and the giveaway is that last step. A product with one
load-bearing promise had a guard added whose job was to keep the promise from
being restated.

The specific failure is not that some accounts would be non-local. It is that
**nothing outside the app would say which**. Someone who installed "Email Local
MCP" on the strength of the page, then connected a mailbox through the path that
requires the least setup, would have their mail handled by a third party while
every document they had read said otherwise. Per-account honesty inside the tool
does not repair a claim made on the outside, because the claim is what they
decided on.

So the code stays and the placement changes. `src/hosted/` is excluded from
`tsconfig.json` — nothing here reaches `dist/`, the npm tarball, or the `.app` —
and is still type-checked (`tsconfig.hosted.json`, `types: []` +
`lib: WebWorker`) and still tested. Two guards keep it there:

- `tools/site-check` fails the build if the landing page ever softens the
  local-only claim, **and** if anything under `src/node` or `src/core` imports
  from `src/hosted`. Prose cannot enforce a reachability property; the import
  check can, and an excluded file is still a resolvable module.
- `tsconfig.hosted.json` fails on any Node built-in, which is what would give a
  hosted module a platform it does not have. The root build has `@types/node`
  loaded and accepts `node:fs` in this directory quite happily — verified.

## Four more things the live API taught us that the docs do not

Each of these has a test, because each is invisible until a real response
arrives:

1. **A failed operation returns HTTP 200.** `{successful:false}` comes back with
   a 200 status. A client trusting `res.ok` reports a failed delete as a success.
2. **`error` is a JSON-encoded string**, not an object, wrapping Google's own
   error envelope. `error.message` misses; passing it through raw prints a
   ten-line blob where a sentence belongs.
3. **`user_id` is mandatory on execute**, even though `connected_account_id`
   identifies the connection uniquely. Omitting it is a 400
   (`ActionExecute_ConnectedAccountEntityIdRequired`).
4. **`GMAIL_REMOVE_LABEL` deletes the label from the account.** It takes no
   message id — "Permanently deletes a specific, existing user-created gmail
   label by its id". The obvious reading of the name would have made
   `modifyLabels(remove:)` destroy a label across every message carrying it.
   Removing a label from one message is `GMAIL_ADD_LABEL_TO_EMAIL` with
   `remove_label_ids`. There is a source-grep test, because this one cannot be
   caught by behaviour: the damage lands on a real mailbox the first time it runs.

Two further rules carried over from prior work against this API:

- **`user_ids` (plural)** is the list filter. The singular `user_id` returns
  other users' rows.
- **A connected-account row is an attempt, not access.** Composio writes it when
  a connect link is *minted*, so an abandoned OAuth flow persists as a
  real-looking row. Only `ACTIVE` counts. The status filter is applied in the
  query string *and* re-checked client side, because a server-side filter that
  stops being honoured fails **open**.

## Architecture

The `ProviderId` doctrine already had the right shape: the id names the
*service*, and capabilities belong to "the route in, not to the brand". So a
Composio-backed Gmail account is `provider: "gmail"` with a different route, not
a new provider id.

**Superseded by the placement above.** The dispatch below was the local design:
`Account.auth` gained a `composio` variant, `credentialFor` a routing-only
credential, and `implFor(providerId, authKind)` a third implementation. All of it
was reverted from `src/node/` — the local registry, credential union and provider
dispatch are back to two modes.

```
ComposioConfig { apiKey }          ← injected by the host, never looked up
        │
        └─ new ComposioGmailProvider(cfg, email, connectedAccountId, userId)
                   │
                   ├─ implements MailProvider   (same 21 methods as GmailProvider)
                   └─ capabilities → GMAIL_CAPABILITIES   (core's constant, by
                                                           reference, not a copy)
```

Two things survived the move into the shared layer, and both are load-bearing:

- `GMAIL_CAPABILITIES`, `MAX_INLINE_ATTACHMENT` and `NotFoundError` moved to
  `src/core/provider.ts`. Both hosts serve Gmail and must answer identically;
  two copies is how `list_accounts` starts describing a mailbox the live provider
  cannot honour. The test asserts *identity*, not deep equality — a structurally
  equal literal declared alongside would satisfy `deepEqual` while being exactly
  the duplicate it guards against.
- The API key is **injected**, not read. The first version reached into the OS
  credential store, which silently made the module node-only and unusable in the
  Worker it is for. `AuthMode` staying a single shared union (wider than
  `LOCAL_AUTH_MODES`) is the same principle: one vocabulary, narrowed per host.

## What it cannot do

Composio's Gmail tools are narrower than `MailProvider` in three places. All
three refuse loudly rather than doing less than asked:

| | Why | Behaviour |
|---|---|---|
| Send with attachments | `GMAIL_SEND_EMAIL` takes **one** attachment and it must already be uploaded to Composio storage (`s3key`); no local paths | throws |
| Send as a reply | No In-Reply-To/References parameter; it threads by Gmail thread id, and an RFC822 Message-ID is not one | throws |
| Bulk operations | No bulk endpoint, so it is search-then-iterate: one request per message | works, but N+1 |

The first two are the important ones. Silently dropping an attachment sends a
mail the user believes carried a file.

## Verification

- **57 unit tests**, fixtures captured from the live API and sanitised.
- **Mutation-tested**: removing the ACTIVE re-check, switching `user_ids` to
  `user_id`, reading `messageId` from the Gmail id, and introducing a
  `GMAIL_REMOVE_LABEL` call site each fail exactly one test, with a clean control
  run after each.
- **Live E2E** against a real ACTIVE connection, in an isolated `HOME`: connect
  listing with identity resolution on 4 connections, adopt, `list`, registry
  contents (no secret), verify, search, getMessage, getThread, listFolders, bulk
  dryRun, and both send refusals. 22/22.
- **Negative controls**: bulk delete without a mailbox, send with attachments,
  send as reply, capabilities by identity, an injected key beating a poisoned
  `COMPOSIO_API_KEY`, and an attachment `savePath` refused rather than ignored.
  The last one caught a real ordering bug: the refusal sat *after* three round
  trips, so a `savePath` caller got "Composio returned no attachment content"
  and would have gone debugging Composio.
- **Placement, mutation-tested**: dropping the absolute claim from the page,
  hedging it, and importing `src/hosted` from `src/node` each fail `site-check`
  with a distinct message; a `Buffer` or `node:fs` reach-through fails
  `tsconfig.hosted.json` while the root build reports zero errors.

## Follow-ups

- Non-Gmail toolkits (Outlook). The shape generalises; each toolkit is its own
  tool-name mapping and its own capabilities answer.
- **The hosted host itself.** This provider has no caller yet. SPEC-287's Worker
  is where it plugs in, and the `ComposioConfig` seam is shaped for a binding.
- **Attachment size on the hosted path is computed from the base64 length**, not
  measured, because `Buffer` is off-limits. Exact, but worth re-reading if
  Composio ever returns unpadded or chunked encodings.
