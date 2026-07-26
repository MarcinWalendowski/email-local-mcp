// PKCE (RFC 7636) and the CSRF state, which are the two things that make an
// authorization-code flow safe without a confidential client.
//
// The verifier never leaves this process; only its SHA-256 hash goes out in the
// authorization request, so a code intercepted on the way back to the loopback
// listener cannot be redeemed by anyone who did not start the flow.

import { createHash, randomBytes } from "node:crypto";

/** Random, URL-safe, unpadded — the alphabet RFC 7636 allows for a verifier. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkce(): Pkce {
  // 32 random bytes → 43 base64url chars, the minimum the RFC allows (43..128).
  const verifier = randomToken(32);
  return { verifier, challenge: challengeFor(verifier), method: "S256" };
}
