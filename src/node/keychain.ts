import { Entry } from "@napi-rs/keyring";
import type { IssuerId } from "./oauth/issuers.js";

// @napi-rs/keyring ships prebuilt native binaries (no node-gyp) and is backed by
// the platform's native store: the macOS Security framework (login Keychain) on
// darwin, the Windows Credential Manager on win32, and the Secret Service
// (gnome-keyring / KWallet) on Linux.
// Exported because the legacy importer (migrate.ts) needs the CURRENT service
// names to copy into. It derives the OLD ones from legacy-names.ts, so these two
// constants stay the single definition of where credentials live today.
export const SERVICE = "email-local-mcp";

// OAuth material lives under its own service name so it can never be confused
// with — or overwrite — an App Password for the same address. An account has one
// credential or the other, never both.
export const OAUTH_SERVICE = "email-local-mcp-oauth";

// Cache passwords in memory for the process lifetime. Reading the store on
// every IMAP/SMTP (re)connect would trigger a "node wants to use your keychain"
// prompt each time on macOS; reading once keeps it quiet.
const cache = new Map<string, string>();

/** Human name of the OS-native credential store, for user-facing messages. */
export function credentialStoreName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "Secret Service (gnome-keyring / KWallet)";
}

/**
 * Actionable guidance when the native store is unavailable. On Linux this is
 * the common failure (no Secret Service running), so we spell out the fix,
 * including a headless-server recipe. On mac/Windows the store is built in, so
 * we just name it and suggest it may be locked.
 */
function storeUnavailableHint(): string {
  if (process.platform === "linux") {
    return (
      "Email Local MCP needs a running Secret Service (gnome-keyring or KWallet) with an unlocked " +
      "login keyring. On a headless machine, start one under a D-Bus session, e.g.: " +
      "dbus-run-session -- sh -c 'gnome-keyring-daemon --start --daemonize; email-local-mcp add <email>'."
    );
  }
  return `Make sure the ${credentialStoreName()} is available and unlocked, then retry.`;
}

function entry(email: string): Entry {
  return new Entry(SERVICE, email.toLowerCase());
}

export function setAppPassword(email: string, appPassword: string): void {
  try {
    entry(email).setPassword(appPassword);
  } catch (e) {
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not save the App Password for ${email} in the ${credentialStoreName()}: ${orig}. ${storeUnavailableHint()}`,
      { cause: e },
    );
  }
  cache.set(email.toLowerCase(), appPassword);
}

export function getAppPassword(email: string): string {
  const key = email.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  let pass: string | null;
  try {
    pass = entry(email).getPassword();
  } catch (e) {
    // A missing entry throws on some backends (Windows / Linux) but returns null
    // on macOS, so this path covers both "none stored" and "store unavailable".
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read the App Password for ${email} from the ${credentialStoreName()}. ` +
        `Either none is stored (run: email-local-mcp add ${email}) or the store is unavailable. ` +
        `${storeUnavailableHint()} (${orig})`,
      { cause: e },
    );
  }
  if (!pass) {
    throw new Error(
      `No App Password found in the ${credentialStoreName()} for ${email}. Run: email-local-mcp add ${email}`,
    );
  }
  cache.set(key, pass);
  return pass;
}

export function hasAppPassword(email: string): boolean {
  if (cache.has(email.toLowerCase())) return true;
  try {
    return Boolean(entry(email).getPassword());
  } catch {
    return false;
  }
}

export function deleteAppPassword(email: string): void {
  cache.delete(email.toLowerCase());
  try {
    entry(email).deletePassword();
  } catch {
    // Nothing stored — treat as already deleted.
  }
}

// ---------- OAuth material ----------
//
// A refresh token is standing access to an entire mailbox, with no expiry a user
// would notice — strictly more dangerous than the App Password it replaces. It
// gets the same treatment: the OS credential store, never `accounts.json`, never
// a log line, never a tool response.

/**
 * `client-secret` is stored because Google issues one even for "Desktop app"
 * clients and rejects the token exchange without it. Google documents it as not
 * actually secret for installed apps, but a plaintext registry file is still the
 * wrong home for something a token endpoint accepts.
 */
export type OAuthSecretKind = "refresh-token" | "client-secret";

const oauthCache = new Map<string, string>();

/**
 * Exported so the legacy importer composes the same key rather than restating
 * the format. Two copies of a key format is how a migration silently reads
 * nothing: it looks up an address that was never written under that spelling.
 */
export function oauthKey(kind: OAuthSecretKind, issuer: IssuerId, email: string): string {
  return `${kind}:${issuer}:${email.toLowerCase()}`;
}

export function setOAuthSecret(
  kind: OAuthSecretKind,
  issuer: IssuerId,
  email: string,
  value: string,
): void {
  const key = oauthKey(kind, issuer, email);
  try {
    new Entry(OAUTH_SERVICE, key).setPassword(value);
  } catch (e) {
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not save the ${kind} for ${email} in the ${credentialStoreName()}: ${orig}. ${storeUnavailableHint()}`,
      { cause: e },
    );
  }
  oauthCache.set(key, value);
}

/** Null when nothing is stored — a normal state the caller turns into "sign in again". */
export function getOAuthSecret(
  kind: OAuthSecretKind,
  issuer: IssuerId,
  email: string,
): string | null {
  const key = oauthKey(kind, issuer, email);
  const cached = oauthCache.get(key);
  if (cached) return cached;
  let value: string | null;
  try {
    value = new Entry(OAUTH_SERVICE, key).getPassword();
  } catch {
    // Missing entries throw on some backends and return null on others.
    return null;
  }
  if (value) oauthCache.set(key, value);
  return value;
}

export function hasOAuthSecret(kind: OAuthSecretKind, issuer: IssuerId, email: string): boolean {
  return Boolean(getOAuthSecret(kind, issuer, email));
}

export function deleteOAuthSecret(
  kind: OAuthSecretKind,
  issuer: IssuerId,
  email: string,
): void {
  const key = oauthKey(kind, issuer, email);
  oauthCache.delete(key);
  try {
    new Entry(OAUTH_SERVICE, key).deletePassword();
  } catch {
    // Nothing stored — treat as already deleted.
  }
}

/** Forget everything OAuth we hold for an account (sign-out, or account removal). */
export function deleteOAuthSecrets(issuer: IssuerId, email: string): void {
  deleteOAuthSecret("refresh-token", issuer, email);
  deleteOAuthSecret("client-secret", issuer, email);
}
