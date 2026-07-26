import {
  deleteAppPassword,
  deleteOAuthSecrets,
  hasAppPassword,
  hasOAuthSecret,
  setAppPassword,
} from "./keychain.js";
import {
  type Account,
  getAccount,
  loadAccounts,
  removeAccount as removeFromRegistry,
  upsertAccount,
} from "./registry.js";
import {
  buildProvider,
  credentialFor,
  dropProvider,
  getProvider,
  resolveConnection,
} from "./providers/index.js";
import { signIn, type SignInRequest } from "./oauth/login.js";
import { forgetAccessToken, revokeRefreshToken } from "./oauth/tokens.js";
import type { AccountSummary, AddAccountInput, SpecialMailboxes } from "../core/index.js";

// Single source of truth for account management, shared by the CLI and the HTTP
// admin API. Never returns or logs the App Password.

/**
 * The shape the CLI and admin API return. Defined in `anymail-core` because
 * `list_accounts` returns it too and the two must not drift; kept under the
 * original name here so this file's callers are unaffected.
 */
export type PublicAccount = AccountSummary;
export type { AddAccountInput };

/**
 * Whether this account has a usable credential — an App Password, or an OAuth
 * refresh token, depending on how it signs in. Which one it is stays out of
 * `AccountSummary` on purpose: the agent only ever needs "can this be used".
 */
export function hasCredential(a: Account): boolean {
  return a.auth?.kind === "oauth"
    ? hasOAuthSecret("refresh-token", a.auth.issuer, a.email)
    : hasAppPassword(a.email);
}

function toPublic(a: Account): PublicAccount {
  return {
    email: a.email,
    displayName: a.displayName ?? null,
    provider: a.provider ?? "gmail",
    default: Boolean(a.default),
    readOnly: Boolean(a.readOnly),
    credentialPresent: hasCredential(a),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function listPublic(): PublicAccount[] {
  return loadAccounts().map(toPublic);
}

/**
 * Store the App Password, verify IMAP + SMTP actually log in, then persist the
 * account. On failure the password is rolled back so we never keep a bad one.
 */
export async function addAccount(input: AddAccountInput): Promise<PublicAccount> {
  const email = input.email.trim();
  const pass = (input.appPassword ?? "").replace(/\s+/g, "");
  if (!email) throw new Error("email is required");
  if (!pass) throw new Error("appPassword is required");

  const providerId = input.provider ?? "gmail";
  const conn = resolveConnection(providerId, input.connection);

  setAppPassword(email, pass);
  const probe = buildProvider(email, providerId, conn);
  try {
    await probe.verify(); // IMAP login + special-mailbox discovery + SMTP login
  } catch (e) {
    deleteAppPassword(email);
    await probe.close();
    throw new Error(`Login failed for ${email}: ${errMsg(e)}. App Password was not saved.`);
  }
  await probe.close();

  const account: Account = {
    email,
    displayName: input.displayName,
    default: input.default,
    readOnly: input.readOnly,
    provider: providerId,
    connection: providerId === "imap" ? conn : undefined,
  };
  upsertAccount(account);
  return toPublic(account);
}

export interface SignInAccountInput extends SignInRequest {
  displayName?: string;
  default?: boolean;
  readOnly?: boolean;
}

/**
 * The OAuth counterpart of `addAccount`: run the browser sign-in, verify the
 * token actually logs in, then persist the account. Same rollback discipline —
 * a token that cannot fetch mail is discarded rather than left behind, so a
 * failed attempt never leaves standing access to a mailbox we did not add.
 */
export async function signInAccount(input: SignInAccountInput): Promise<PublicAccount> {
  const email = input.email.trim();
  if (!email) throw new Error("email is required");

  const { config } = await signIn({ ...input, email });
  const providerId = input.issuer.providerId;
  const conn = resolveConnection(providerId, input.issuer.connection);

  const account: Account = {
    email,
    displayName: input.displayName,
    default: input.default,
    readOnly: input.readOnly,
    provider: providerId,
    connection: providerId === "imap" ? conn : undefined,
    auth: config,
  };

  const probe = buildProvider(email, providerId, conn, credentialFor(account));
  try {
    await probe.verify(); // IMAP login + special-mailbox discovery + SMTP login
  } catch (e) {
    deleteOAuthSecrets(config.issuer, email);
    forgetAccessToken(email, config.issuer);
    await probe.close();
    throw new Error(
      `${input.issuer.label} sign-in succeeded for ${email}, but the IMAP/SMTP login did not: ${errMsg(e)}. ` +
        `The token was discarded and no account was added. If this is a work account, IMAP or authenticated SMTP may be disabled for the mailbox.`,
    );
  }
  await probe.close();

  upsertAccount(account);
  // Signing in over an existing App Password account: drop the cached provider
  // so the running engine picks up the new credential, and delete the password,
  // which no longer authenticates anything here. A credential nobody uses is a
  // credential nobody revokes.
  dropProvider(email);
  deleteAppPassword(email);
  return toPublic(account);
}

/**
 * Forget an account's OAuth tokens, keeping the account itself. Revokes at the
 * provider where one offers an endpoint — deleting our copy does not invalidate
 * a refresh token, and "disconnect" ought to mean it.
 */
export async function signOutAccount(email: string): Promise<{ revoked: boolean }> {
  const account = getAccount(email);
  if (account.auth?.kind !== "oauth") {
    throw new Error(
      `${account.email} signs in with an App Password, not OAuth. Use: anymail-mcp remove ${account.email}`,
    );
  }
  const revoked = await revokeRefreshToken(account.email, account.auth);
  deleteOAuthSecrets(account.auth.issuer, account.email);
  forgetAccessToken(account.email, account.auth.issuer);
  dropProvider(account.email);
  return { revoked };
}

export async function testAccount(email: string): Promise<{ ok: true; mailboxes: SpecialMailboxes }> {
  const mailboxes = await getProvider(email).verify();
  return { ok: true, mailboxes };
}

export async function removeAccount(email: string): Promise<void> {
  const account = loadAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
  if (account?.auth?.kind === "oauth") {
    // Best-effort: removing an account should not leave live standing access to
    // its mailbox at the provider.
    await revokeRefreshToken(account.email, account.auth);
    deleteOAuthSecrets(account.auth.issuer, account.email);
    forgetAccessToken(account.email, account.auth.issuer);
  }
  deleteAppPassword(email);
  dropProvider(email);
  removeFromRegistry(email);
}

export function setDefault(email: string): PublicAccount {
  const account = getAccount(email);
  upsertAccount({ ...account, default: true });
  return toPublic({ ...account, default: true });
}
