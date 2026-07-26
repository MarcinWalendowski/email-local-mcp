// Who we can sign in to, and where their OAuth endpoints live.
//
// Two issuers, because two problems: Microsoft retired basic auth for IMAP on
// Exchange Online, so a Microsoft account is OAuth or nothing; and Google works
// today only because the user hand-made an App Password, which is the friction
// this removes.
//
// **No client ids live here, deliberately.** A local sign-in needs an OAuth
// client registered by *somebody*, and an open-source desktop app cannot ship
// one: Google's mail scopes are "restricted", so a client that ships in a public
// binary would need the app's own verification + annual CASA assessment before
// anyone but a test user could use it, and an unverified client hands out
// refresh tokens that die after 7 days. So the client id is the user's — see
// docs/oauth.md — and this file only knows where to send it.

import type { ConnectionConfig, ProviderId } from "../../core/index.js";

export type IssuerId = "google" | "microsoft";

/**
 * An account's binding to an issuer, as stored in the registry.
 *
 * Every field here is **non-secret** and belongs in `accounts.json`: which
 * issuer, whose client, what was consented to. The refresh token — and the
 * client secret, when the issuer type needs one — go to the OS credential store
 * instead (see keychain.ts). The registry has never held a secret and must not
 * start.
 */
export interface OAuthConfig {
  kind: "oauth";
  issuer: IssuerId;
  clientId: string;
  /** Exactly what was consented to, so a scope change can be detected/reported. */
  scopes: string[];
  /** Microsoft only: the directory to authenticate against ("common" by default). */
  tenant?: string;
  /** Pinned loopback port, when the registration demands an exact redirect URI. */
  redirectPort?: number;
}

export interface OAuthIssuer {
  id: IssuerId;
  label: string;
  /**
   * Which `MailProvider` serves an account of this issuer. Google keeps the full
   * `gmail` provider (labels, threads, X-GM-RAW) — OAuth changes how we
   * authenticate, not what Gmail can do. Microsoft is generic `imap`: folders,
   * no labels, text search, which is what Exchange over IMAP actually offers.
   */
  providerId: ProviderId;
  /** IMAP/SMTP endpoints, for issuers whose `providerId` has no preset. */
  connection?: ConnectionConfig;
  /**
   * Scopes for IMAP + SMTP access. Note these are *not* the REST scopes: Gmail's
   * `gmail.modify` does not grant IMAP, which needs the full-mailbox scope.
   */
  defaultScopes: string[];
  /** Extra query params on the authorization request. */
  authorizeParams: Record<string, string>;
  /**
   * Whether the token endpoint expects a `client_secret`. Google issues one even
   * for "Desktop app" clients and rejects the exchange without it (it is not
   * treated as a secret there); Microsoft public clients must not send one.
   */
  usesClientSecret: boolean;
  /** Microsoft-style `{tenant}` in the endpoint URLs. */
  supportsTenant: boolean;
  /** Where the user registers the client id they have to supply. */
  registrationDocs: string;
}

/** Exchange Online / Outlook.com IMAP + SMTP (STARTTLS on 587). */
const OUTLOOK_CONNECTION: ConnectionConfig = {
  imapHost: "outlook.office365.com",
  imapPort: 993,
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  smtpSecure: false,
};

export const ISSUERS: Record<IssuerId, OAuthIssuer> = {
  google: {
    id: "google",
    label: "Google",
    providerId: "gmail",
    defaultScopes: ["https://mail.google.com/"],
    // access_type=offline is what makes Google return a refresh token at all;
    // prompt=consent makes it return one *again* on a repeat sign-in, instead of
    // silently omitting it and leaving us with an hour of access.
    authorizeParams: { access_type: "offline", prompt: "consent" },
    usesClientSecret: true,
    supportsTenant: false,
    registrationDocs: "https://console.cloud.google.com/apis/credentials",
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft",
    providerId: "imap",
    connection: OUTLOOK_CONNECTION,
    defaultScopes: [
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
      // Without this Microsoft returns no refresh token and the account would
      // stop working an hour later.
      "offline_access",
    ],
    authorizeParams: { prompt: "select_account" },
    usesClientSecret: false,
    supportsTenant: true,
    registrationDocs: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
  },
};

/** CLI-friendly spellings — `gmail` because that is what `add --provider` calls it. */
const ALIASES: Record<string, IssuerId> = {
  google: "google",
  gmail: "google",
  microsoft: "microsoft",
  outlook: "microsoft",
  office365: "microsoft",
};

export function issuerAliases(): string[] {
  return Object.keys(ALIASES);
}

/** Resolve a user-typed issuer name. Throws with the accepted spellings. */
export function resolveIssuer(name: string): OAuthIssuer {
  const id = ALIASES[name.trim().toLowerCase()];
  if (!id) {
    throw new Error(`Unknown --provider "${name}". One of: ${issuerAliases().join(", ")}.`);
  }
  return ISSUERS[id];
}

/**
 * A tenant goes straight into a URL path, so it is validated rather than
 * trusted: GUIDs, domain names, and the `common`/`organizations`/`consumers`
 * pseudo-tenants all match, a path traversal does not.
 */
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_]*$/;

export interface IssuerEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Where a refresh token can be invalidated at the provider, when there is one. */
  revokeUrl: string | null;
}

export function issuerEndpoints(issuer: OAuthIssuer, tenant?: string): IssuerEndpoints {
  if (issuer.id === "google") {
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
    };
  }
  const t = tenant?.trim() || "common";
  if (!TENANT_RE.test(t)) {
    throw new Error(
      `Invalid --tenant "${t}". Use a tenant GUID, a domain (contoso.onmicrosoft.com), or one of common / organizations / consumers.`,
    );
  }
  const base = `https://login.microsoftonline.com/${t}/oauth2/v2.0`;
  return {
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    // Microsoft has no single-token revocation endpoint; sign-out invalidates
    // every refresh token for the app, which is not what "disconnect one
    // account" means. Deleting our copy is the honest local action.
    revokeUrl: null,
  };
}
