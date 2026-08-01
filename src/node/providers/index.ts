import { type Account, getAccount, resolveEmail } from "../registry.js";
import { GMAIL_CAPABILITIES, GmailProvider } from "./gmail.js";
import { IMAP_CAPABILITIES, ImapProvider } from "./imap.js";
import { APP_PASSWORD, type MailCredential } from "../credential.js";
import { tokenSourceFor } from "../oauth/tokens.js";
import type {
  ConnectionConfig,
  MailProvider,
  ProviderCapabilities,
  ProviderId,
} from "../../core/index.js";

export type { MailProvider } from "../../core/index.js";
export { ImapProvider } from "./imap.js";
export { GmailProvider } from "./gmail.js";

const IDLE_CLOSE_MS = 5 * 60 * 1000;

/**
 * Built-in IMAP/SMTP endpoints for known providers. `imap` = bring-your-own host.
 *
 * `microsoft` is excluded because it names the Graph (HTTP) implementation, which
 * has no IMAP/SMTP endpoints to preset. This app reaches a Microsoft mailbox over
 * IMAP/SMTP instead — `login --provider microsoft` registers it as `imap` with
 * Exchange Online's endpoints, and gets plain-IMAP capabilities accordingly.
 */
export const PRESETS: Record<Exclude<ProviderId, "imap" | "microsoft">, ConnectionConfig> = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false, // iCloud SMTP is STARTTLS on 587
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
};

/** Resolve the connection config for a provider — preset, or the supplied one for `imap`. */
export function resolveConnection(
  providerId: ProviderId,
  connection?: ConnectionConfig,
): ConnectionConfig {
  if (providerId === "microsoft") {
    throw new Error(
      'Provider "microsoft" is the hosted Microsoft Graph implementation and has no IMAP/SMTP endpoints. ' +
        "This app reaches a Microsoft mailbox over IMAP: use `login <email> --provider microsoft`, which registers it as `imap`.",
    );
  }
  if (providerId === "imap") {
    if (!connection) {
      throw new Error('Provider "imap" requires a connection config (imapHost/smtpHost/…).');
    }
    return connection;
  }
  return PRESETS[providerId];
}

/**
 * How an account authenticates. Absent `auth` means an App Password, which is
 * every account written before OAuth existed — so this is also the guarantee
 * that nothing changed for them.
 */
export function credentialFor(account: Account): MailCredential {
  if (account.auth?.kind !== "oauth") return APP_PASSWORD;
  const source = tokenSourceFor(account.email, account.auth);
  return { kind: "oauth", getAccessToken: () => source.getAccessToken() };
}

/**
 * Construct (but do not cache) a provider instance.
 *
 * This is the seam a non-IMAP provider plugs into. A `MailProvider` backed by an
 * HTTP API (Gmail REST, Microsoft Graph) needs exactly what an OAuth credential
 * already carries — "a bearer token for this account, refreshed if necessary" —
 * so adding one is a branch here plus the class, with no change to the tool
 * layer, the registry, the credential store, or the sign-in flow.
 *
 * A provider that CANNOT be built from a bearer token does not belong on this
 * host at all. `src/hosted/` holds one: Composio never releases its access
 * token, so serving a mailbox through it means the mail transits a third party,
 * which contradicts the one claim this local app makes. It is compiled out of
 * this target entirely rather than gated at runtime.
 */
export function buildProvider(
  email: string,
  providerId: ProviderId,
  conn: ConnectionConfig,
  credential: MailCredential = APP_PASSWORD,
): MailProvider {
  return implFor(providerId) === "gmail"
    ? new GmailProvider(email, conn, credential)
    : new ImapProvider(email, conn, providerId, credential);
}

type Impl = "gmail" | "imap";

/**
 * The one dispatch: which implementation serves an account. `buildProvider` and
 * `capabilitiesFor` both go through it so they cannot disagree about an account
 * — a `list_accounts` that advertised capabilities the live provider does not
 * have would be worse than not advertising them at all.
 *
 * The `ProviderId` doctrine holds: the id names the *service*, and capabilities
 * belong to "the route in, not to the brand". On this host every route in is a
 * local IMAP/SMTP connection, so the id alone decides.
 */
function implFor(providerId: ProviderId): Impl {
  return providerId === "gmail" ? "gmail" : "imap";
}

/**
 * What an account can do, without building or connecting one.
 *
 * `list_accounts` runs for every configured account including ones with no usable
 * credential, so it cannot go through `getProvider` (which resolves an OAuth
 * token source). Capabilities are a property of the implementation, not of the
 * session, so answering statically is exact rather than a guess.
 *
 */
export function capabilitiesFor(providerId: ProviderId): ProviderCapabilities {
  return implFor(providerId) === "imap" ? IMAP_CAPABILITIES : GMAIL_CAPABILITIES;
}

const cache = new Map<string, MailProvider>();
let sweeper: NodeJS.Timeout | undefined;

/** Get the live provider for a configured account (cached, connection-pooled). */
export function getProvider(email: string): MailProvider {
  const existing = cache.get(email);
  if (existing) return existing;
  const account = getAccount(email); // throws if not configured
  const providerId = account.provider ?? "gmail";
  const conn = resolveConnection(providerId, account.connection);
  const provider = buildProvider(email, providerId, conn, credentialFor(account));
  cache.set(email, provider);
  return provider;
}

/** Resolve an optional account arg to its provider (default account if omitted). */
export function getProviderFor(account?: string): MailProvider {
  return getProvider(resolveEmail(account));
}

/** Forget and disconnect a provider (used when an account is removed). */
export function dropProvider(email: string): void {
  const p = cache.get(email);
  cache.delete(email);
  if (p) void p.close();
}

export function startIdleSweep(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const p of cache.values()) void p.closeIfIdle(IDLE_CLOSE_MS);
  }, 60_000);
  sweeper.unref?.();
}

export async function closeAll(): Promise<void> {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
  await Promise.allSettled([...cache.values()].map((p) => p.close()));
  cache.clear();
}
