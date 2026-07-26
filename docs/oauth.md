# Signing in with OAuth

`anymail-mcp login` connects an account by sending you to Google's or
Microsoft's own sign-in page in your browser, instead of asking you to create an
App Password by hand. It is how you connect a **Microsoft 365 / Outlook**
account at all (Microsoft retired basic auth for IMAP, so an App Password is no
longer an option there), and an alternative to App Passwords for **Gmail**.

Nothing about existing accounts changes. An account added with `anymail-mcp add`
keeps working exactly as before, with its App Password in the OS credential
store, and no migration.

## You need your own OAuth client

There is one piece of setup this app cannot do for you: **you register the OAuth
client, and pass its id to `login`.**

That is not laziness. Mail scopes are "restricted" at Google, so a client id
shipped inside a public open-source binary would need that app to pass Google's
own verification plus an annual third-party security assessment before anyone
but a handful of test users could sign in, and an unverified client hands out
refresh tokens that stop working after 7 days. A client you create belongs to
you, is used by you, and has none of those limits. It takes about five minutes,
once.

### Google

1. Open <https://console.cloud.google.com/apis/credentials> and create (or pick)
   a project.
2. **Enable the Gmail API** for it (APIs & Services → Library → Gmail API).
3. Configure the OAuth consent screen. If this is a personal `@gmail.com`
   account, choose **External** and add your own address under **Test users**.
4. Create credentials → **OAuth client ID** → application type **Desktop app**.
5. Copy the **client ID** and **client secret**. Google issues a secret even for
   desktop clients, and its token endpoint refuses the exchange without one;
   Google documents that secret as not actually secret for installed apps. AnyMail
   stores it in the OS credential store all the same, never in `accounts.json`.

```bash
anymail-mcp login you@gmail.com \
  --provider gmail \
  --client-id  1234-abc.apps.googleusercontent.com \
  --client-secret GOCSPX-… \
  --default
```

The scope requested is `https://mail.google.com/`, because that is what IMAP and
SMTP need. (The narrower `gmail.modify` scope covers the REST API only and does
not grant IMAP access.)

> **Test-user caveat.** While the consent screen is in *Testing*, Google expires
> refresh tokens after 7 days, so you will have to run `login` again each week.
> Publishing the app removes that, and for a personal client used only by you,
> Google's verification requirements are far lighter than for a distributed one.

### Microsoft

1. Open <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps> →
   **New registration**.
2. Supported account types: personal Microsoft accounts, your organization, or
   both, whichever matches the mailbox.
3. Add a platform → **Mobile and desktop applications** → custom redirect URI
   `http://127.0.0.1` (see "Redirect URI" below if your registration needs an
   exact port).
4. API permissions → **APIs my organization uses** → *Office 365 Exchange
   Online* → Delegated → `IMAP.AccessAsUser.All` and `SMTP.Send`. Add
   `offline_access` from Microsoft Graph.
5. Copy the **Application (client) ID**. Do **not** create a client secret: this
   is a public client and sending one is rejected.

```bash
anymail-mcp login you@contoso.com \
  --provider microsoft \
  --client-id 00000000-1111-2222-3333-444444444444 \
  --tenant contoso.onmicrosoft.com
```

`--tenant` defaults to `common`, which works for personal accounts and for
tenants that allow it. Use your tenant id or domain when your organization
requires it.

> **Your admin may have to help.** Exchange Online tenants can disable IMAP or
> authenticated SMTP per mailbox, and can require admin consent for the
> permissions above. If sign-in succeeds but the IMAP login fails, that is
> usually why, and `login` will tell you so and store nothing.

## Redirect URI

`login` starts a one-shot listener on `127.0.0.1` and uses
`http://127.0.0.1:<port>` as the redirect. By default the port is whatever is
free at the time, which Google's desktop clients allow. If your registration
lists an exact URI, pin it:

```bash
anymail-mcp login you@contoso.com … --redirect-port 8123
```

and register `http://127.0.0.1:8123`.

The listener accepts one request, only from this machine, and shuts down as soon
as the browser comes back or after five minutes, whichever is first.

## What is stored, and where

| Thing | Where |
| ----- | ----- |
| Refresh token | OS credential store (macOS Keychain / Windows Credential Manager / Secret Service) |
| Client secret (Google) | Same store |
| Access token | Memory only, for the life of the process |
| Issuer, client id, scopes, tenant | `~/.anymail-mcp/accounts.json` (all non-secret) |

The access token is refreshed automatically, a minute before it expires. You are
not asked to sign in again unless the grant is revoked, the mailbox password
changes, or an unverified Google client hits its 7-day limit; the error message
says which and what to run.

## Disconnecting

```bash
anymail-mcp logout you@gmail.com   # forget the tokens, keep the account
anymail-mcp remove you@gmail.com   # forget both
```

Both revoke the token at the provider where the provider offers an endpoint for
it (Google does; Microsoft does not, and per-app sign-out through your account
security settings is the equivalent there).

## Other providers

iCloud, Fastmail and generic IMAP hosts do not have an OAuth path here and do
not need one: they issue app-specific passwords by design. Use
[`anymail-mcp add`](../README.md#get-an-app-password).
