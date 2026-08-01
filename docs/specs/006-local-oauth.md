# Local OAuth sign-in

Status: Accepted (implemented; unreleased)

Grounded in the current code: `src/node/oauth/` (new), `src/node/credential.ts`
(new), `src/node/keychain.ts`, `src/node/registry.ts`, `src/node/accounts.ts`,
`src/node/providers/{index,imap,gmail}.ts`, `src/node/cli.ts`. User-facing
instructions live in [`docs/oauth.md`](../oauth.md).

## Problem

Every account this app can connect is authenticated with an App Password the
user creates by hand. That has two costs, one of them fatal:

1. **Microsoft is unreachable.** Basic authentication for IMAP on Exchange
   Online is retired. There is no App Password to create; a Microsoft account is
   OAuth or nothing, and "nothing" is where the app currently is.
2. **Gmail asks for a chore.** An App Password means 2FA, a settings page most
   people have never opened, and a 16-character string pasted into a terminal.
   It works, and it is the single most common place a new user gets stuck.

The obvious answer, "sign in with Google / Microsoft", has a catch that shapes
the whole design: **an OAuth client belongs to whoever registers it**, and mail
scopes are restricted. A client id compiled into a public, MIT-licensed binary
would drag this project into Google's verification process and an annual
third-party security assessment, and until that completed it would issue refresh
tokens that expire after seven days. A local mail tool cannot own that.

## Design

### The user brings the client id

`email-local-mcp login <email> --client-id <id>` requires a client the user
registered, and refuses to run without one, with a message that says where to get
it. No client id, secret, or issuer default that could be mistaken for one is
committed anywhere in this repo (`src/node/oauth/issuers.ts` holds endpoints and
scopes only). The five minutes of setup buys an unlimited, unexpiring,
un-verified grant that belongs to the person using it.

### One flow, RFC 8252 shaped

Authorization code + PKCE against a loopback redirect, which is the flow every
desktop mail client uses:

```
login  ->  start a one-shot listener on 127.0.0.1:<port>
       ->  open the system browser at the issuer's consent screen
             (state + S256 code_challenge, login_hint = the address)
       ->  browser returns to 127.0.0.1 with ?code=&state=
       ->  state checked, listener closed
       ->  POST the token endpoint with the code + code_verifier
       ->  refresh token to the OS credential store
       ->  verify IMAP + SMTP actually log in, then write the account
```

Split across `pkce.ts`, `loopback.ts`, `browser.ts`, `tokens.ts` and `login.ts`,
so the parts that can be wrong on their own (the state check, the challenge, the
callback parse, the token response, the error text) are pure functions with
tests. The browser is opened best-effort and the URL is always printed, so a
headless or SSH session costs a copy-paste rather than the feature.

### Credentials keep their existing home

The refresh token goes where App Passwords already go: the OS credential store,
under a separate service name (`email-local-mcp-oauth`) so it can never collide with
or overwrite a password for the same address. `accounts.json` gains only
non-secret fields: issuer, client id, scopes, tenant, pinned port.

A refresh token is strictly more dangerous than the App Password it replaces:
standing access to an entire mailbox, with no expiry the user would notice. So
`remove` and `logout` revoke it at the provider where the provider offers an
endpoint (Google does, Microsoft does not), a failed `login` discards it rather
than leaving it behind, and no code path logs token material.

### The seam: a credential, not a provider

`src/node/credential.ts` defines the whole of what a provider needs to know:

```ts
type MailCredential =
  | { kind: "app-password" }
  | { kind: "oauth"; getAccessToken(): Promise<string> };
```

`buildProvider(email, providerId, conn, credential)` threads it through, and
**absent `auth` in the registry means `app-password`**, which is every account
that existed before this change. That default is the compatibility guarantee:
nothing migrates, nothing re-authenticates, nothing behaves differently.

Today both issuers are served over IMAP/SMTP with SASL XOAUTH2, which Gmail and
Exchange Online both accept, so OAuth needed no new provider at all: Gmail keeps
the full `GmailProvider` (labels, threads, X-GM-RAW) and Microsoft gets the
generic `ImapProvider` against `outlook.office365.com`, whose
`capabilities.labels: false` already routes `bulk_modify_labels` to a refusal
that names `bulk_move`.

The same seam is what a future HTTP-backed provider (Gmail REST, Microsoft
Graph) plugs into. Such a provider wants exactly what the `oauth` branch already
supplies, a bearer token refreshed on demand, and would differ only in putting it
in an `Authorization` header instead of an XOAUTH2 SASL string. Adding one is a
branch in `buildProvider` plus the class: no change to the tool layer, the
registry, the credential store, or this flow.

### What did not change

The MCP tool surface, byte for byte (`npm run surface`, empty diff). In
particular `add_account` still takes an App Password and still advertises only
`gmail | icloud | fastmail | imap`: it is the tool for the credential a model can
be handed, and a browser consent screen is not that. Signing in is a CLI act by
the human who owns the mailbox, which is the same reason `add_account`'s own
description points at the app's GUI for the most private path.

`AccountSummary.credentialPresent` needed no new field either; it was already
documented as deliberately vague about *which* credential, because the agent only
ever needs "can this account be used".

## Verification

Automated (`npm test`, node's built-in runner via tsx, 26 assertions):

- PKCE against the RFC 7636 appendix B vector; verifier length and alphabet.
- Callback parsing: correct state accepted, wrong state and absent state
  rejected, provider `error=` surfaced, unrelated requests ignored.
- Endpoint construction per issuer, tenant interpolation, and a tenant
  containing `/` or `..` refused rather than pasted into a URL.
- Token response parsing, the default expiry, the refresh skew window, and a
  response with no `access_token` throwing instead of caching an empty string.
- Error text: `invalid_grant` names the command that fixes it, `invalid_client`
  names the client-secret asymmetry, token material never appears in a message.
- Authorize URL: PKCE, redirect, scopes, `access_type=offline` for Google,
  tenant path for Microsoft.

Mutation-checked: neutering the state comparison and widening the refresh skew
each fail the suite.

Manual, needing a registered client and a real mailbox (not run yet):

1. `login` a Gmail account, then `test`, `search_messages`, `send_message`.
2. Confirm the account works with **no App Password** in the credential store.
3. Expire the access token (wait an hour, or delete the in-memory cache by
   restarting the engine) and confirm the next call refreshes silently.
4. Revoke the grant at the provider; confirm the next call fails with the
   "sign in again" message rather than a stack trace.
5. The same for a Microsoft 365 mailbox, including `bulk_modify_labels`
   refusing and naming `bulk_move`.
6. `logout`, then `list`, and confirm the account is shown as signed out.
7. An existing App Password account continues to work untouched throughout.
