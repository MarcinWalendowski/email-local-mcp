// The local sign-in: authorization code + PKCE against a loopback redirect.
//
// This is the desktop-app flow (RFC 8252) rather than anything Email Local invented:
// start a listener on 127.0.0.1, send the user to the provider's consent screen
// in their own browser, catch the redirect, redeem the code. The credential we
// keep is the refresh token; everything else here is scaffolding that exists for
// the ninety seconds the browser is open.

import { setOAuthSecret } from "../keychain.js";
import { openBrowser } from "./browser.js";
import { ISSUERS, issuerEndpoints, type OAuthConfig, type OAuthIssuer } from "./issuers.js";
import { startLoopbackReceiver } from "./loopback.js";
import { createPkce, randomToken } from "./pkce.js";
import { exchangeCode } from "./tokens.js";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function buildAuthorizeUrl(args: {
  issuer: OAuthIssuer;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  loginHint?: string;
  tenant?: string;
}): string {
  const url = new URL(issuerEndpoints(args.issuer, args.tenant).authorizeUrl);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.scopes.join(" "),
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    ...args.issuer.authorizeParams,
  };
  // Pre-fills the account picker with the address being connected, so a user
  // with several signed-in accounts cannot silently authorize the wrong mailbox.
  if (args.loginHint) params.login_hint = args.loginHint;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export interface SignInRequest {
  email: string;
  issuer: OAuthIssuer;
  clientId: string;
  /** Only for issuers whose token endpoint expects one (Google desktop clients). */
  clientSecret?: string;
  tenant?: string;
  /** Overrides the issuer's default IMAP/SMTP scopes. */
  scopes?: string[];
  /** Pin the loopback port when the registration lists an exact redirect URI. */
  redirectPort?: number;
  openInBrowser?: boolean;
  timeoutMs?: number;
  /** Where to print the URL, so a headless or remote session can still finish. */
  onPrompt?: (message: string) => void;
}

export interface SignInResult {
  config: OAuthConfig;
  /** What the provider actually granted, when it says. */
  grantedScope?: string;
}

/**
 * Run the flow and store the refresh token. Does **not** touch the account
 * registry: the caller verifies the account works before recording it, and rolls
 * the stored secrets back if it does not.
 */
export async function signIn(req: SignInRequest): Promise<SignInResult> {
  const issuer = req.issuer;
  const scopes = req.scopes?.length ? req.scopes : issuer.defaultScopes;
  const config: OAuthConfig = {
    kind: "oauth",
    issuer: issuer.id,
    clientId: req.clientId,
    scopes,
    tenant: issuer.supportsTenant ? (req.tenant?.trim() || "common") : undefined,
    redirectPort: req.redirectPort,
  };

  const state = randomToken(16);
  const pkce = createPkce();
  const receiver = await startLoopbackReceiver({
    port: req.redirectPort,
    state,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  let tokens;
  try {
    const url = buildAuthorizeUrl({
      issuer,
      clientId: req.clientId,
      redirectUri: receiver.redirectUri,
      scopes,
      state,
      codeChallenge: pkce.challenge,
      loginHint: req.email,
      tenant: config.tenant,
    });

    req.onPrompt?.(
      `Opening ${issuer.label} sign-in for ${req.email}.\nIf your browser does not open, paste this URL:\n\n${url}\n`,
    );
    if (req.openInBrowser !== false) openBrowser(url);

    const code = await receiver.waitForCode();
    tokens = await exchangeCode({
      cfg: config,
      email: req.email,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: receiver.redirectUri,
      clientSecret: req.clientSecret,
    });
  } finally {
    receiver.close();
  }

  if (!tokens.refreshToken) {
    // Without one we would have an hour of access and no way to renew it, which
    // is worse than failing now: the account would appear to work and then stop.
    throw new Error(
      `${issuer.label} returned no refresh token for ${req.email}, so the connection could not be kept alive. ` +
        (issuer.id === "google"
          ? "This usually means the client is not a 'Desktop app' client, or consent was already granted to a different client."
          : "Check that the app registration includes the 'offline_access' scope."),
    );
  }

  if (req.clientSecret) {
    setOAuthSecret("client-secret", issuer.id, req.email, req.clientSecret);
  }
  setOAuthSecret("refresh-token", issuer.id, req.email, tokens.refreshToken);

  return { config, grantedScope: tokens.scope };
}

/** The issuer record behind a stored config. */
export function issuerFor(config: OAuthConfig): OAuthIssuer {
  return ISSUERS[config.issuer];
}
