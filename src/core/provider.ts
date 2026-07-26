// The provider abstraction. Every account is served by one MailProvider; Gmail
// is one implementation (IMAP + X-GM-* extensions), and any other IMAP/SMTP host
// (iCloud, Fastmail, generic) is served by the base ImapProvider. Adding a
// provider = implement this interface (usually by extending ImapProvider).

export type ProviderId = "gmail" | "icloud" | "fastmail" | "imap";

/** IMAP + SMTP endpoints for an account. Presets fill this for known providers. */
export interface ConnectionConfig {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** true = implicit TLS (465); false = STARTTLS (587). */
  smtpSecure: boolean;
}

/** What a provider can do, so the tool layer / model doesn't assume Gmail. */
export interface ProviderCapabilities {
  /** Gmail-style multi-labels (a message can carry many). False = single-folder model. */
  labels: boolean;
  /** Threads resolvable server-side (Gmail X-GM-THRID). */
  threads: boolean;
  /** Rich native search (Gmail X-GM-RAW). False = a limited IMAP-SEARCH subset. */
  nativeSearch: boolean;
}

/** Special-use mailboxes, discovered by IMAP flag (never hard-coded — they are localized). */
export interface SpecialMailboxes {
  inbox: string;
  all?: string;
  archive?: string;
  trash?: string;
  drafts?: string;
  sent?: string;
  junk?: string;
}

export interface MessageSummary {
  /**
   * Opaque, provider-defined message id — the handle callers pass back to act on
   * this message. Gmail: X-GM-MSGID. Generic IMAP: folder+uidvalidity+uid.
   * Distinct from `messageId`, which is the RFC822 Message-ID header.
   */
  id: string | null;
  /** Opaque thread id (Gmail X-GM-THRID); null on providers without server-side threads. */
  threadId: string | null;
  /**
   * IMAP UID within its mailbox. **Null on providers that have no such concept**
   * — an HTTP mail API addresses messages by `id` and never by UID.
   *
   * Nullable rather than faked: a `0` on every message from such a provider is a
   * value the model can read and reason about, and it would be a lie. Nothing
   * uses this as a handle (that is `id`, deliberately opaque), so a null costs
   * nothing.
   */
  uid: number | null;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  labels: string[];
  flags: string[];
  unread: boolean;
  size: number | null;
}

export interface FullMessage extends MessageSummary {
  text: string | null;
  html: string | null;
  attachments: { index: number; filename: string; contentType: string; size: number }[];
}

export interface Folder {
  path: string;
  name: string;
  specialUse: string | null;
}

export interface AttachmentInput {
  filename?: string;
  /** Absolute path to a local file. */
  path?: string;
  /** Base64-encoded content (used when no path is given). */
  contentBase64?: string;
  contentType?: string;
}

export interface ComposeInput {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** RFC822 Message-ID of the message being replied to (sets In-Reply-To/References). */
  inReplyTo?: string;
  attachments?: AttachmentInput[];
}

export interface SendResult {
  messageId: string;
  /**
   * Per-recipient SMTP outcome and the server's reply line. **Optional**: they
   * are SMTP artefacts, and a provider that sends over HTTP is told only that
   * the whole message was accepted. Omitted is honest; `[]` would read as "no
   * recipient accepted it", which is the opposite of what happened.
   */
  accepted?: string[];
  rejected?: string[];
  response?: string;
}

export type AttachmentResult =
  | { filename: string; contentType: string; size: number; contentBase64: string }
  | { filename: string; contentType: string; size: number; saved: string };

/** A small status object returned by write ops. Always carries the message id. */
export interface MutationResult {
  id: string;
  [key: string]: unknown;
}

/** Options common to every query-first bulk operation. */
export interface BulkOpts {
  /**
   * What to match. On Gmail this is X-GM-RAW syntax (e.g. "older_than:1y"); on
   * generic IMAP a full-text SEARCH. Omit to match the whole mailbox.
   */
  query?: string;
  /** Mailbox to run in. Omit to use the account's whole-mail scope (Gmail: All Mail). */
  mailbox?: string;
  /** Preview only: return the matched count + a small sample, changing nothing. */
  dryRun?: boolean;
  /** Required to actually run a destructive or large (>100) batch. */
  confirm?: boolean;
  /**
   * Cap on how many messages a single call acts on, so a large batch stays under
   * the MCP client's tool timeout. Applies only to message-removing ops
   * (trash/move/delete/empty); flag ops are cheap and run uncapped. When the
   * result is `done:false`, re-run the same call to continue. Default 2000.
   */
  max?: number;
}

/** Outcome of a bulk operation. Never reports success it didn't achieve. */
export interface BulkResult {
  /** The mailbox the operation ran in. */
  mailbox: string;
  /** How many messages the query matched. */
  matched: number;
  /** How many were actually mutated (0 on dryRun / needsConfirm). */
  affected: number;
  /** Rough count still matching after this call (matched − affected). */
  remaining: number;
  /**
   * True when this call finished the whole matched set (nothing left to do).
   * False when a removing-op batch was capped by `max` — re-run the same call to
   * continue. Failures are reported in `failed[]` regardless.
   */
  done: boolean;
  dryRun: boolean;
  /** True when the op stopped to ask for confirm:true (destructive or matched > 100). */
  needsConfirm?: boolean;
  /** Human-readable hint (present on needsConfirm, or when nothing matched). */
  message?: string;
  /** A few matched messages (newest first) for the caller/agent to eyeball. */
  sample: MessageSummary[];
  /**
   * Per-chunk failures — a partial failure never fails the whole op silently.
   * `uid` is null on providers without UIDs; `id` carries the opaque handle,
   * which is the only identifier a caller can act on either way.
   */
  failed: { uid: number | null; id?: string; error: string }[];
}

export interface MailProvider {
  readonly id: ProviderId;
  readonly email: string;
  readonly capabilities: ProviderCapabilities;

  /** Log in over IMAP + SMTP and discover special mailboxes. Used by add/test. */
  verify(): Promise<SpecialMailboxes>;

  // read
  search(query: string, limit: number, folder?: string): Promise<MessageSummary[]>;
  getMessage(id: string): Promise<FullMessage>;
  getThread(threadId: string): Promise<MessageSummary[]>;
  listFolders(): Promise<Folder[]>;
  getAttachment(id: string, index: number, savePath?: string): Promise<AttachmentResult>;

  // create
  send(input: ComposeInput): Promise<SendResult>;
  createDraft(input: ComposeInput): Promise<{ mailbox: string; uid: number | null }>;
  createFolder(name: string): Promise<{ path: string; created: boolean }>;

  // update
  modifyLabels(id: string, add: string[], remove: string[]): Promise<MutationResult>;
  markRead(id: string, on: boolean): Promise<MutationResult>;
  star(id: string, on: boolean): Promise<MutationResult>;
  archive(id: string): Promise<MutationResult>;
  move(id: string, target: string): Promise<MutationResult>;

  // delete
  trash(id: string): Promise<MutationResult>;
  delete(id: string): Promise<MutationResult>;

  // bulk (query-first: match a set in one mailbox, act on all of it in one pass)
  bulkMarkRead(on: boolean, opts: BulkOpts): Promise<BulkResult>;
  /** Gmail-only (label model). The generic provider throws — use bulkMove instead. */
  bulkModifyLabels(add: string[], remove: string[], opts: BulkOpts): Promise<BulkResult>;
  bulkMove(target: string, opts: BulkOpts): Promise<BulkResult>;
  bulkTrash(opts: BulkOpts): Promise<BulkResult>;
  /** Permanent. Requires an explicit mailbox; on Gmail only Trash/Spam expunge for real. */
  bulkDelete(opts: BulkOpts): Promise<BulkResult>;
  /** Permanently empty the Trash ("trash") or Spam/Junk ("junk") mailbox. */
  bulkEmpty(which: "trash" | "junk", opts: BulkOpts): Promise<BulkResult>;

  // lifecycle (connection pooling / idle sweep, driven by the registry)
  close(): Promise<void>;
  closeIfIdle(maxIdleMs: number): Promise<void>;
}
