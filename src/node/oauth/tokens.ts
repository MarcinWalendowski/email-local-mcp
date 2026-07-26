// Access tokens: obtaining them, refreshing them before they die, and never
// letting one leak.
//
// The refresh token is the durable credential (it sits in the OS credential
// store next to where App Passwords go). The access token is derived, lives an
// hour, and is cached only in this process's memory — so a crash costs one
// round-trip and nothing is written that a backup could carry off.
//
// `TokenSource` is deliberately the whole seam. Anything that needs to
// authenticate as the user asks for a bearer string and does not care where it
// came from: today the IMAP/SMTP providers hand it to XOAUTH2, and a future
// HTTP provider (Gmail REST, Microsoft Graph) puts it in an Authorization
// header. Neither has to know about refresh, storage, or the issuer.

import { logger } from "../logger.js";
import { getOAuthSecret, setOAuthSecret } from "../keychain.js";
import { ISSUERS, issuerEndpoints, type IssuerEndpoints, type OAuthConfig } from "./issuers.js";

/** All any consumer of an authenticated identity needs. */
export interface TokenSource {
  getAccessToken(): Promise<string>;
}

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Present on the first exchange, and on issuers that rotate (Microsoft does). */
  refreshToken?: string;
  scope?: string;
}

/** Refresh this far before expiry, so a long IMAP call cannot straddle the edge. */
export const EXPIRY_SKEW_MS = 60_000;

export function isFresh(token: { expiresAt: number } | undefined, now: number): boolean {
  return Boolean(token && token.expiresAt - EXPIRY_SKEW_MS > now);
}

/**
 * Normalise a token endpoint's JSON. Missing `expires_in` is treated as one
 * hour, which is every issuer's default and errs towards refreshing too often
 * rather than presenting a dead token to a mail server.
 */
export function parseTokenResponse(raw: unknown, now: number): TokenSet {
  const body = (raw ?? {}) as Record<string, unknown>;
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) {
    throw new Error("The token endpoint returned no access_token.");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken,
    expiresAt: now + expiresIn * 1000,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

/**
 * Turn a token-endpoint failure into something a person can act on. The one that
 * matters is `invalid_grant`: the user revoked access, changed their password,
 * or (on an unverified Google client) hit the 7-day refresh-token expiry — all
 * of which mean "sign in again", and none of which say so on their own.
 */
export function tokenErrorMessage(status: number, body: string, email: string): string {
  let code = "";
  let description = "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    code = typeof parsed.error === "string" ? parsed.error : "";
    description =
      typeof parsed.error_description === "string" ? parsed.error_description : "";
  } catch {
    description = body.slice(0, 300);
  }
  const detail = [code, description].filter(Boolean).join(": ") || `HTTP ${status}`;
  if (code === "invalid_grant") {
    return (
      `The sign-in for ${email} is no longer valid (${detail}). This happens when access was revoked, ` +
      `the account's password changed, or the OAuth client is still unverified (Google expires those ` +
      `refresh tokens after 7 days). Sign in again:  anymail-mcp login ${email}`
    );
  }
  if (code === "invalid_client") {
    return (
      `The OAuth client was rejected for ${email} (${detail}). Check --client-id, and whether the ` +
      `issuer expects a client secret (Google "Desktop app" clients do; Microsoft public clients must not send one).`
    );
  }
  return `Token request failed for ${email} (${detail}).`;
}

async function postForm(
  url: string,
  params: Record<string, string>,
  email: string,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not reach the token endpoint for ${email}: ${orig}`, { cause: e });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(tokenErrorMessage(res.status, text, email));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`The token endpoint returned a non-JSON response for ${email}.`);
  }
  return parseTokenResponse(json, Date.now());
}

function clientSecretFor(cfg: OAuthConfig, email: string): string | undefined {
  if (!ISSUERS[cfg.issuer].usesClientSecret) return undefined;
  return getOAuthSecret("client-secret", cfg.issuer, email) ?? undefined;
}

function endpointsFor(cfg: OAuthConfig): IssuerEndpoints {
  return issuerEndpoints(ISSUERS[cfg.issuer], cfg.tenant);
}

/** Redeem an authorization code. Called once, by the sign-in flow. */
export async function exchangeCode(args: {
  cfg: OAuthConfig;
  email: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientSecret?: string;
}): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: args.cfg.clientId,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  };
  if (args.clientSecret) params.client_secret = args.clientSecret;
  return postForm(endpointsFor(args.cfg).tokenUrl, params, args.email);
}

async function refreshWithToken(
  cfg: OAuthConfig,
  email: string,
  refreshToken: string,
): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  };
  const secret = clientSecretFor(cfg, email);
  if (secret) params.client_secret = secret;
  const tokens = await postForm(endpointsFor(cfg).tokenUrl, params, email);
  // Microsoft rotates the refresh token on every use; dropping the new one would
  // leave us holding an invalidated credential and locked out at the next call.
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    setOAuthSecret("refresh-token", cfg.issuer, email, tokens.refreshToken);
    logger.debug({ email, issuer: cfg.issuer }, "oauth refresh token rotated");
  }
  return tokens;
}

interface CacheEntry {
  accessToken: string;
  expiresAt: number;
}

const accessCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

function cacheKey(email: string, cfg: OAuthConfig): string {
  return `${cfg.issuer}:${email.toLowerCase()}`;
}

/** Drop the cached access token for an account (sign-out, account removal). */
export function forgetAccessToken(email: string, issuer: OAuthConfig["issuer"]): void {
  accessCache.delete(`${issuer}:${email.toLowerCase()}`);
}

/**
 * A `TokenSource` for a configured account. Refreshes on demand, at most once at
 * a time — IMAP and SMTP both reach for a token, and two simultaneous refreshes
 * against an issuer that rotates would race to store different tokens.
 */
export function tokenSourceFor(email: string, cfg: OAuthConfig): TokenSource {
  const key = cacheKey(email, cfg);
  return {
    async getAccessToken(): Promise<string> {
      const cached = accessCache.get(key);
      if (isFresh(cached, Date.now())) return (cached as CacheEntry).accessToken;

      const pending = inFlight.get(key);
      if (pending) return (await pending).accessToken;

      const run = (async (): Promise<CacheEntry> => {
        const refreshToken = getOAuthSecret("refresh-token", cfg.issuer, email);
        if (!refreshToken) {
          throw new Error(
            `No OAuth sign-in stored for ${email}. Run:  anymail-mcp login ${email} --provider ${cfg.issuer === "google" ? "gmail" : "microsoft"} --client-id <id>`,
          );
        }
        const tokens = await refreshWithToken(cfg, email, refreshToken);
        const entry: CacheEntry = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
        accessCache.set(key, entry);
        logger.debug({ email, issuer: cfg.issuer }, "oauth access token refreshed");
        return entry;
      })();

      inFlight.set(key, run);
      try {
        return (await run).accessToken;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}

/**
 * Best-effort revocation at the provider. Deleting our copy of a refresh token
 * does not invalidate it, so where an issuer offers a revoke endpoint we use it;
 * Microsoft offers none (see `issuerEndpoints`) and returns false.
 */
export async function revokeRefreshToken(email: string, cfg: OAuthConfig): Promise<boolean> {
  const url = endpointsFor(cfg).revokeUrl;
  const token = getOAuthSecret("refresh-token", cfg.issuer, email);
  if (!url || !token) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
