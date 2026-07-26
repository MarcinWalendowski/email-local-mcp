// Tests for the parts of the OAuth flow that are decidable without a network,
// a browser, or a credential store — which is most of what can go wrong:
// PKCE, the callback check, endpoint construction, token-response parsing, and
// the error text a user has to act on.
//
// Run: npm test   (node's built-in runner, TypeScript via tsx — no test
// framework is installed, and none is needed for pure functions.)
//
// What is deliberately NOT here: the browser round-trip and the token endpoint.
// Both need a registered OAuth client and a real mailbox, so they are a manual
// verification step (docs/specs/006-local-oauth.md), not a green tick in CI.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ISSUERS, issuerEndpoints, resolveIssuer } from "./issuers.js";
import { challengeFor, createPkce, randomToken } from "./pkce.js";
import { parseCallback } from "./loopback.js";
import { EXPIRY_SKEW_MS, isFresh, parseTokenResponse, tokenErrorMessage } from "./tokens.js";
import { buildAuthorizeUrl } from "./login.js";
import { browserCommand } from "./browser.js";

describe("issuers", () => {
  it("accepts the spellings a user is likely to type", () => {
    assert.equal(resolveIssuer("gmail").id, "google");
    assert.equal(resolveIssuer("Google").id, "google");
    assert.equal(resolveIssuer(" microsoft ").id, "microsoft");
    assert.equal(resolveIssuer("outlook").id, "microsoft");
    assert.throws(() => resolveIssuer("yahoo"), /Unknown --provider/);
  });

  it("asks Google for the full-mailbox scope, not the REST one", () => {
    // gmail.modify does not grant IMAP; getting this wrong fails only at connect
    // time, after the user has already consented to the wrong thing.
    assert.deepEqual(ISSUERS.google.defaultScopes, ["https://mail.google.com/"]);
  });

  it("asks Microsoft for offline_access, without which there is no refresh token", () => {
    assert.ok(ISSUERS.microsoft.defaultScopes.includes("offline_access"));
  });

  it("builds tenant-scoped Microsoft endpoints, defaulting to common", () => {
    const common = issuerEndpoints(ISSUERS.microsoft);
    assert.equal(common.authorizeUrl, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    assert.equal(common.tokenUrl, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    assert.equal(common.revokeUrl, null);

    const scoped = issuerEndpoints(ISSUERS.microsoft, "contoso.onmicrosoft.com");
    assert.match(scoped.tokenUrl, /\/contoso\.onmicrosoft\.com\/oauth2\/v2\.0\/token$/);
  });

  it("refuses a tenant that would escape the URL path", () => {
    assert.throws(() => issuerEndpoints(ISSUERS.microsoft, "../evil"), /Invalid --tenant/);
    assert.throws(() => issuerEndpoints(ISSUERS.microsoft, "a/b"), /Invalid --tenant/);
  });

  it("ignores tenant for Google, which has none", () => {
    const e = issuerEndpoints(ISSUERS.google, "contoso");
    assert.equal(e.authorizeUrl, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(e.revokeUrl, "https://oauth2.googleapis.com/revoke");
  });
});

describe("pkce", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    assert.equal(
      challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("produces a verifier in the allowed length and alphabet", () => {
    const { verifier, challenge, method } = createPkce();
    assert.equal(method, "S256");
    assert.ok(verifier.length >= 43 && verifier.length <= 128);
    assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
    assert.equal(challenge, challengeFor(verifier));
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomToken(16)));
    assert.equal(seen.size, 50);
  });
});

describe("callback parsing", () => {
  const STATE = "s-123";

  it("accepts a code carrying the state we sent", () => {
    assert.deepEqual(parseCallback(`/?code=abc&state=${STATE}`, STATE), { kind: "code", code: "abc" });
  });

  it("rejects a code with the wrong state, and says nothing was stored", () => {
    const out = parseCallback("/?code=abc&state=someone-else", STATE);
    assert.equal(out.kind, "error");
    assert.match((out as { message: string }).message, /state mismatch/);
  });

  it("rejects a code with no state at all", () => {
    assert.equal(parseCallback("/?code=abc", STATE).kind, "error");
  });

  it("surfaces the provider's own refusal", () => {
    const out = parseCallback(`/?error=access_denied&error_description=User+said+no&state=${STATE}`, STATE);
    assert.equal(out.kind, "error");
    assert.match((out as { message: string }).message, /access_denied: User said no/);
  });

  it("ignores requests that are not the callback", () => {
    assert.equal(parseCallback("/favicon.ico", STATE).kind, "ignore");
    assert.equal(parseCallback("/", STATE).kind, "ignore");
  });
});

describe("token responses", () => {
  it("turns expires_in into an absolute expiry", () => {
    const t = parseTokenResponse({ access_token: "at", expires_in: 3599, refresh_token: "rt" }, 1_000_000);
    assert.equal(t.accessToken, "at");
    assert.equal(t.refreshToken, "rt");
    assert.equal(t.expiresAt, 1_000_000 + 3599 * 1000);
  });

  it("assumes an hour when the issuer does not say", () => {
    const t = parseTokenResponse({ access_token: "at" }, 0);
    assert.equal(t.expiresAt, 3600 * 1000);
    assert.equal(t.refreshToken, undefined);
  });

  it("refuses a response with no access token rather than caching an empty string", () => {
    assert.throws(() => parseTokenResponse({ token_type: "Bearer" }, 0), /no access_token/);
    assert.throws(() => parseTokenResponse(null, 0), /no access_token/);
  });

  it("treats a token inside the skew window as already stale", () => {
    const now = 1_000_000;
    assert.equal(isFresh({ expiresAt: now + EXPIRY_SKEW_MS * 2 }, now), true);
    assert.equal(isFresh({ expiresAt: now + EXPIRY_SKEW_MS / 2 }, now), false);
    assert.equal(isFresh({ expiresAt: now - 1 }, now), false);
    assert.equal(isFresh(undefined, now), false);
  });
});

describe("token errors", () => {
  it("turns invalid_grant into the instruction that fixes it", () => {
    const m = tokenErrorMessage(400, JSON.stringify({ error: "invalid_grant" }), "a@b.com");
    assert.match(m, /anymail-mcp login a@b\.com/);
    assert.match(m, /revoked/);
  });

  it("names the client-secret asymmetry on invalid_client", () => {
    const m = tokenErrorMessage(401, JSON.stringify({ error: "invalid_client" }), "a@b.com");
    assert.match(m, /client secret/);
  });

  it("falls back to the raw body when it is not JSON", () => {
    const m = tokenErrorMessage(502, "<html>bad gateway</html>", "a@b.com");
    assert.match(m, /bad gateway/);
  });

  it("never echoes a token back into the message", () => {
    const m = tokenErrorMessage(400, JSON.stringify({ error: "invalid_grant", access_token: "SECRET" }), "a@b.com");
    assert.ok(!m.includes("SECRET"));
  });
});

describe("authorize URL", () => {
  const base = {
    clientId: "cid",
    redirectUri: "http://127.0.0.1:51234",
    state: "st",
    codeChallenge: "ch",
    loginHint: "a@b.com",
  };

  it("carries PKCE, the loopback redirect, and the space-joined scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...base, issuer: ISSUERS.google, scopes: ["s1", "s2"] }),
    );
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "cid");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:51234");
    assert.equal(url.searchParams.get("scope"), "s1 s2");
    assert.equal(url.searchParams.get("state"), "st");
    assert.equal(url.searchParams.get("code_challenge"), "ch");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("login_hint"), "a@b.com");
  });

  it("asks Google for offline access, or there is no refresh token to store", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...base, issuer: ISSUERS.google, scopes: ISSUERS.google.defaultScopes }),
    );
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
  });

  it("points at the requested Microsoft tenant", () => {
    const url = new URL(
      buildAuthorizeUrl({
        ...base,
        issuer: ISSUERS.microsoft,
        scopes: ISSUERS.microsoft.defaultScopes,
        tenant: "contoso.onmicrosoft.com",
      }),
    );
    assert.match(url.pathname, /^\/contoso\.onmicrosoft\.com\//);
  });
});

describe("browser launcher", () => {
  it("passes the URL as an argument, never through a shell string", () => {
    assert.deepEqual(browserCommand("https://x/?a=b&c=d", "darwin"), {
      command: "open",
      args: ["https://x/?a=b&c=d"],
    });
    // The empty title argument is what stops cmd's `start` swallowing the URL.
    assert.deepEqual(browserCommand("https://x", "win32"), {
      command: "cmd",
      args: ["/c", "start", "", "https://x"],
    });
    assert.equal(browserCommand("https://x", "linux").command, "xdg-open");
  });
});
