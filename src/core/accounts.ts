// The seam between the portable tool layer and whatever is hosting it.
//
// `registerTools` needs four things it cannot supply itself: which accounts
// exist, which address an optional `account` argument means, whether that
// address accepts writes, and the live `MailProvider` for it. Locally those come
// from a JSON registry beside the macOS Keychain; on a hosted deployment they
// come from per-user OAuth tokens in durable storage. Neither belongs in here.
//
// This is an INTERFACE, deliberately, not a registry: the moment core knows how
// accounts are stored, it stops being portable, and the two deployments start
// drifting in exactly the place the split exists to keep identical.

import type {
  ConnectionConfig,
  MailProvider,
  ProviderCapabilities,
  ProviderId,
} from "./provider.js";

/**
 * How an account signs in, and — the part that matters to a user — what that
 * implies about where their mail goes.
 *
 * **Wider than any one host on purpose.** `app-password` and `oauth` are served
 * by a connection opened from the user's own machine to the mail host, and they
 * are the only two the local app can produce (`LOCAL_AUTH_MODES` in
 * `src/node/accounts.ts` is the authority on that, and what the landing page is
 * checked against). `composio` belongs to a hosted deployment, where a third
 * party fetches and sends the mail because Composio never releases the access
 * token.
 *
 * The union stays shared rather than being split per host so that a summary
 * crossing between them keeps one vocabulary. A host narrows it; nothing widens
 * what a host can actually do by adding a member here.
 */
export type AuthMode = "app-password" | "oauth" | "composio";

/**
 * One configured account, exactly as `list_accounts` reports it.
 *
 * `credentialPresent` is deliberately vague about *what* credential: locally it
 * means an App Password sits in the OS store, hosted it means a usable OAuth
 * refresh token. The agent only ever needs to know "can this account be used".
 *
 * `capabilities` is carried per account rather than left for the agent to infer
 * from `provider`, because that inference is wrong: the same Microsoft mailbox is
 * a folder store with no threads over IMAP and a threaded, searchable one over
 * Graph. This field is what every capability-keyed tool description points at, so
 * a host that guessed it would be lying to the model in the one place the model
 * was told to look.
 */
export interface AccountSummary {
  email: string;
  displayName: string | null;
  provider: ProviderId;
  capabilities: ProviderCapabilities;
  default: boolean;
  readOnly: boolean;
  credentialPresent: boolean;
  /** How this account authenticates. */
  authMode: AuthMode;
  /**
   * True when this account's mail is handled entirely by a connection opened
   * from the user's own machine. False means a third party fetches and sends it.
   *
   * Present so the *agent* can answer "where does my mail go" truthfully without
   * having to know what a given `authMode` implies. A model reading `authMode`
   * alone would have to infer the consequence; this states it.
   *
   * The local host answers `true` for every account, and says so explicitly
   * rather than omitting the field. An absent answer to a question about privacy
   * reads as evasion, and the field costs one boolean.
   */
  mailHandledLocally: boolean;
}

export interface AddAccountInput {
  email: string;
  appPassword: string;
  displayName?: string;
  default?: boolean;
  readOnly?: boolean;
  /** Defaults to "gmail". */
  provider?: ProviderId;
  /** Required only for provider "imap" (custom host). Presets cover the rest. */
  connection?: ConnectionConfig;
}

/**
 * Account *management*, which only a host that owns a credential store can
 * offer. Optional on purpose: a hosted deployment connects an account by sending
 * the user through a provider consent screen, so `add_account` — which takes a
 * password as an argument — has no meaning there and must not be advertised.
 *
 * This is the one place the two hosts legitimately differ, and making it a
 * separate optional block is what keeps that difference from being expressible
 * anywhere in the mail tools themselves.
 */
export interface AccountAdmin {
  /**
   * Human name of the credential store ("macOS Keychain"), interpolated into
   * `add_account`'s description so the tool tells the truth about where the
   * password lands. A string, not a function: tool descriptions are built once,
   * at registration.
   */
  credentialStoreName: string;
  addAccount(input: AddAccountInput): Promise<AccountSummary>;
}

/** Everything `registerTools` needs from its host. */
export interface MailHost {
  /** Every configured account, as `list_accounts` reports it. */
  listAccounts(): Promise<AccountSummary[]>;
  /**
   * Resolve an optional `account` argument to a configured address. With no
   * argument, the host's default account. Throws when there is nothing to
   * resolve to — the tool layer surfaces that as a tool error.
   */
  resolveEmail(account?: string): Promise<string>;
  /** Throw if the account refuses writes. Called at the top of every write tool. */
  assertWritable(email: string): Promise<void>;
  /** The live provider for a resolved address. */
  getProvider(email: string): Promise<MailProvider>;
  /** Only hosts that own a credential store; gates the `add_account` tool. */
  accountAdmin?: AccountAdmin;
}
