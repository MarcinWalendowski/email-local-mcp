import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ImapFlow, type FetchQueryObject, type SearchObject } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { simpleParser } from "mailparser";
import { getAppPassword } from "../keychain.js";
import { APP_PASSWORD, type MailCredential } from "../credential.js";
import { logger } from "../logger.js";
import type {
  AttachmentInput,
  AttachmentResult,
  BulkOpts,
  BulkResult,
  ComposeInput,
  ConnectionConfig,
  Folder,
  FullMessage,
  MailProvider,
  MessageSummary,
  MutationResult,
  ProviderCapabilities,
  ProviderId,
  SendResult,
  SpecialMailboxes,
} from "../../core/index.js";

// ---------- shared helpers (also used by GmailProvider) ----------

export type FetchMsg = Awaited<ReturnType<ImapFlow["fetchAll"]>>[number];
export type Address = { name?: string; address?: string };

export const MAX_INLINE_ATTACHMENT = 5_000_000; // require a savePath above this

/** Summary fetch fields available on any IMAP server. */
export const BASE_SUMMARY_QUERY = {
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
} as const;

export async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export function fmtAddr(list?: Address[]): string {
  if (!list?.length) return "";
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")))
    .join(", ");
}

export function toIso(d?: Date | string | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Build a MessageSummary from a fetch result. `emailId`/`threadId`/`labels` are
 * Gmail extensions; on a plain IMAP server they are simply absent (null/[]).
 */
export function formatSummary(msg: FetchMsg): MessageSummary {
  const env = msg.envelope ?? ({} as NonNullable<FetchMsg["envelope"]>);
  const flags = msg.flags ?? new Set<string>();
  return {
    id: msg.emailId ?? null,
    threadId: msg.threadId ?? null,
    uid: msg.uid,
    subject: env.subject ?? "",
    from: fmtAddr(env.from as Address[] | undefined),
    to: fmtAddr(env.to as Address[] | undefined),
    cc: fmtAddr(env.cc as Address[] | undefined),
    date: toIso(env.date ?? msg.internalDate),
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    labels: msg.labels ? [...msg.labels] : [],
    flags: [...flags],
    unread: !flags.has("\\Seen"),
    size: msg.size ?? null,
  };
}

export function byDateDesc(a: MessageSummary, b: MessageSummary): number {
  return (b.date ?? "").localeCompare(a.date ?? "");
}

// ---------- bulk helpers ----------

/** A batch requiring confirm:true once it would touch more than this many messages. */
export const BULK_CONFIRM_OVER = 100;
/** Max UIDs per IMAP command — bounds command-line length even for scattered ids. */
const BULK_CHUNK = 500;
/** How many matched messages to include as a preview sample. */
const BULK_SAMPLE = 10;
/**
 * Max messages a single removing-op call (trash/move/delete/empty) acts on before
 * returning done:false, so one call stays under the MCP client's tool timeout.
 * Acted messages leave the search scope, so re-running the same call continues.
 * Flag ops (mark_read/labels) don't self-narrow and are cheap, so they run uncapped.
 */
const DEFAULT_BULK_MAX = 2000;

/** The mutation a bulk op applies to a UID set. */
export type BulkAction =
  | { kind: "flags"; add?: string[]; remove?: string[]; useLabels?: boolean }
  | { kind: "move"; target: string }
  | { kind: "delete" };

/** Split a UID list into fixed-size chunks (sorted ascending). */
export function chunkUids(uids: number[], size = BULK_CHUNK): number[][] {
  const sorted = [...uids].sort((a, b) => a - b);
  const out: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

/** Compact a sorted UID chunk into an IMAP sequence set ("12,15:20,30") to keep commands short. */
export function toRange(uids: number[]): string {
  if (uids.length === 0) return "";
  const parts: string[] = [];
  let start = uids[0];
  let prev = uids[0];
  for (let i = 1; i < uids.length; i++) {
    const u = uids[i];
    if (u === prev + 1) {
      prev = u;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = prev = u;
  }
  parts.push(start === prev ? `${start}` : `${start}:${prev}`);
  return parts.join(",");
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Message ${id} not found in this account (it may have moved — re-run search).`);
  }
}

// ---------- base provider ----------

const ID_SEP = "\t"; // IMAP mailbox names never contain a tab

/**
 * Generic IMAP + SMTP provider. Works against any standard IMAP/SMTP host
 * (iCloud, Fastmail, self-hosted). Folder-based (no labels), best-effort search,
 * no server-side threads — GmailProvider extends this and overrides the ops that
 * use Gmail's X-GM-* extensions.
 *
 * Message ids are opaque "uidvalidity|uid|folder" composites: unique and
 * cheap for the search→act flow, though they don't survive a message being moved
 * (re-run search after a move). Gmail overrides ids with the stable X-GM-MSGID.
 */
export class ImapProvider implements MailProvider {
  readonly id: ProviderId;
  readonly email: string;
  readonly capabilities: ProviderCapabilities = {
    labels: false,
    threads: false,
    nativeSearch: false,
  };

  protected readonly conn: ConnectionConfig;
  protected readonly credential: MailCredential;

  private client?: ImapFlow;
  private connecting?: Promise<ImapFlow>;
  private transporter?: Transporter;
  private boxesCache?: SpecialMailboxes;
  private lastUsed = 0;

  constructor(
    email: string,
    conn: ConnectionConfig,
    id: ProviderId = "imap",
    credential: MailCredential = APP_PASSWORD,
  ) {
    this.email = email;
    this.conn = conn;
    this.id = id;
    this.credential = credential;
  }

  // ----- connection / lifecycle -----

  /**
   * IMAP and SMTP both authenticate as this account; only *how* differs. An
   * access token goes over SASL XOAUTH2, which is the mechanism Gmail and
   * Exchange Online both expect and — since Microsoft retired basic auth — the
   * only one Exchange still accepts.
   */
  private async imapAuth(): Promise<{ user: string; pass?: string; accessToken?: string }> {
    if (this.credential.kind === "oauth") {
      return { user: this.email, accessToken: await this.credential.getAccessToken() };
    }
    return { user: this.email, pass: getAppPassword(this.email) };
  }

  protected async getClient(): Promise<ImapFlow> {
    if (this.client && this.client.usable) {
      this.lastUsed = Date.now();
      return this.client;
    }
    this.client = undefined;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new ImapFlow({
        host: this.conn.imapHost,
        port: this.conn.imapPort,
        secure: true,
        auth: await this.imapAuth(),
        logger: false,
      });
      client.on("error", (err: Error) => {
        logger.warn({ email: this.email, err: err.message }, "imap connection error");
      });
      client.on("close", () => {
        if (this.client === client) this.client = undefined;
      });
      await client.connect();
      this.client = client;
      this.lastUsed = Date.now();
      logger.debug({ email: this.email, provider: this.id }, "imap connected");
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  protected async getTransport(): Promise<Transporter> {
    const smtp = {
      host: this.conn.smtpHost,
      port: this.conn.smtpPort,
      secure: this.conn.smtpSecure,
    };
    if (this.credential.kind === "oauth") {
      // Built per use, not cached: an access token expires under a cached
      // transporter and the next send would fail with a stale credential. SMTP
      // connections are not pooled here, so this costs a config object.
      return nodemailer.createTransport({
        ...smtp,
        auth: {
          type: "OAuth2",
          user: this.email,
          accessToken: await this.credential.getAccessToken(),
        },
      });
    }
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        ...smtp,
        auth: { user: this.email, pass: getAppPassword(this.email) },
      });
    }
    return this.transporter;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.transporter = undefined;
    if (c) await c.logout().catch(() => c.close());
  }

  async closeIfIdle(maxIdleMs: number): Promise<void> {
    if (this.client && Date.now() - this.lastUsed > maxIdleMs) {
      await this.close();
      logger.debug({ email: this.email }, "imap idle-closed");
    }
  }

  // ----- mailbox discovery -----

  protected async boxes(): Promise<SpecialMailboxes> {
    if (this.boxesCache) return this.boxesCache;
    const client = await this.getClient();
    const boxes: SpecialMailboxes = { inbox: "INBOX" };
    for (const mb of await client.list()) {
      switch (mb.specialUse) {
        case "\\All":
          boxes.all = mb.path;
          break;
        case "\\Archive":
          boxes.archive = mb.path;
          break;
        case "\\Trash":
          boxes.trash = mb.path;
          break;
        case "\\Drafts":
          boxes.drafts = mb.path;
          break;
        case "\\Sent":
          boxes.sent = mb.path;
          break;
        case "\\Junk":
          boxes.junk = mb.path;
          break;
      }
    }
    this.boxesCache = boxes;
    return boxes;
  }

  protected requireBox(
    boxes: SpecialMailboxes,
    key: "all" | "archive" | "trash" | "drafts" | "sent" | "junk",
  ): string {
    const path = boxes[key];
    if (!path) throw new Error(`This account has no ${key} mailbox exposed over IMAP.`);
    return path;
  }

  /** The mailbox to open for whole-account browsing (All Mail if present, else INBOX). */
  protected searchScope(boxes: SpecialMailboxes): string {
    return boxes.all ?? boxes.inbox;
  }

  // ----- id encoding (generic) -----

  protected makeId(path: string, uidValidity: bigint | number | string, uid: number): string {
    // uidvalidity + uid first (numeric, separator-free); path last (may contain the separator).
    return `${String(uidValidity)}${ID_SEP}${uid}${ID_SEP}${path}`;
  }

  private parseId(id: string): { path: string; uidValidity: string; uid: number } {
    const parts = id.split(ID_SEP);
    if (parts.length < 3 || !parts[1]) {
      throw new Error(`Malformed message id "${id}" for a non-Gmail account. Re-run search.`);
    }
    return { uidValidity: parts[0], uid: Number(parts[1]), path: parts.slice(2).join(ID_SEP) };
  }

  /** Open the folder an id points at, verify UIDVALIDITY, run `fn(client, uid)`. */
  protected async withMessage<T>(
    id: string,
    fn: (client: ImapFlow, uid: number) => Promise<T>,
  ): Promise<T> {
    const { path, uidValidity, uid } = this.parseId(id);
    const client = await this.getClient();
    return withMailbox(client, path, async () => {
      if (client.mailbox && String(client.mailbox.uidValidity) !== uidValidity) {
        throw new Error(`Message id is stale (folder "${path}" changed). Re-run search.`);
      }
      return fn(client, uid);
    });
  }

  // ----- shared: verify / send / draft / folders (identical for Gmail) -----

  async verify(): Promise<SpecialMailboxes> {
    const boxes = await this.boxes(); // forces IMAP connect + LIST
    await (await this.getTransport()).verify(); // forces SMTP login
    return boxes;
  }

  private toAttachments(atts?: AttachmentInput[]) {
    return (atts ?? []).map((a) =>
      a.path
        ? { filename: a.filename, path: a.path, contentType: a.contentType }
        : {
            filename: a.filename,
            content: Buffer.from(a.contentBase64 ?? "", "base64"),
            contentType: a.contentType,
          },
    );
  }

  async send(input: ComposeInput): Promise<SendResult> {
    const transport = await this.getTransport();
    const info = await transport.sendMail({
      from: this.email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.inReplyTo ? [input.inReplyTo] : undefined,
      attachments: this.toAttachments(input.attachments),
    });
    return {
      messageId: info.messageId,
      accepted: info.accepted as string[],
      rejected: info.rejected as string[],
      response: info.response,
    };
  }

  async createDraft(input: ComposeInput): Promise<{ mailbox: string; uid: number | null }> {
    // Build raw MIME without sending (stream transport), then APPEND to Drafts.
    const generator = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: "\r\n",
    });
    const built = await generator.sendMail({
      from: this.email,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.inReplyTo ? [input.inReplyTo] : undefined,
      attachments: this.toAttachments(input.attachments),
    });
    const raw = (built as unknown as { message: Buffer }).message;

    const client = await this.getClient();
    const boxes = await this.boxes();
    const drafts = this.requireBox(boxes, "drafts");
    const resp = await client.append(drafts, raw, ["\\Draft"]);
    return { mailbox: drafts, uid: resp && resp.uid != null ? resp.uid : null };
  }

  async createFolder(name: string): Promise<{ path: string; created: boolean }> {
    const client = await this.getClient();
    const res = await client.mailboxCreate(name);
    return { path: res.path, created: res.created };
  }

  async listFolders(): Promise<Folder[]> {
    const client = await this.getClient();
    const list = await client.list();
    return list.map((mb) => ({ path: mb.path, name: mb.name, specialUse: mb.specialUse ?? null }));
  }

  // ----- generic read ops -----

  async search(query: string, limit = 25, folder?: string): Promise<MessageSummary[]> {
    const client = await this.getClient();
    const boxes = await this.boxes();
    const scope = folder ?? this.searchScope(boxes);
    return withMailbox(client, scope, async () => {
      // Best-effort: full-text server-side SEARCH. Not Gmail syntax (capabilities.nativeSearch = false).
      const criteria = query.trim() ? { text: query.trim() } : { all: true };
      const uids = await client.search(criteria, { uid: true });
      if (!uids || uids.length === 0) return [];
      const chosen = uids.slice(-Math.max(1, limit));
      const uidValidity = client.mailbox ? client.mailbox.uidValidity : 0;
      const msgs = await client.fetchAll(chosen, BASE_SUMMARY_QUERY, { uid: true });
      return msgs
        .map((m) => {
          const s = formatSummary(m);
          s.id = this.makeId(scope, uidValidity, m.uid);
          return s;
        })
        .sort(byDateDesc);
    });
  }

  async getMessage(id: string): Promise<FullMessage> {
    return this.withMessage(id, async (client, uid) => {
      const msg = await client.fetchOne(String(uid), { ...BASE_SUMMARY_QUERY, source: true }, { uid: true });
      if (!msg) throw new NotFoundError(id);
      const summary = formatSummary(msg);
      summary.id = id;
      const parsed = await simpleParser(msg.source as Buffer);
      return {
        ...summary,
        text: parsed.text ?? null,
        html: typeof parsed.html === "string" ? parsed.html : null,
        attachments: (parsed.attachments ?? []).map((a, index) => ({
          index,
          filename: a.filename ?? `attachment-${index}`,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    });
  }

  async getThread(_threadId: string): Promise<MessageSummary[]> {
    throw new Error(
      "This provider has no server-side threads. Fetch messages individually with get_message.",
    );
  }

  async getAttachment(id: string, index: number, savePath?: string): Promise<AttachmentResult> {
    return this.withMessage(id, async (client, uid) => {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!msg) throw new NotFoundError(id);
      const parsed = await simpleParser(msg.source as Buffer);
      const att = parsed.attachments?.[index];
      if (!att) {
        throw new Error(`No attachment at index ${index} (message has ${parsed.attachments?.length ?? 0}).`);
      }
      const filename = att.filename ?? `attachment-${index}`;
      if (savePath) {
        await mkdir(dirname(savePath), { recursive: true });
        await writeFile(savePath, att.content);
        return { filename, contentType: att.contentType, size: att.size, saved: savePath };
      }
      if (att.size > MAX_INLINE_ATTACHMENT) {
        throw new Error(`Attachment is ${att.size} bytes; too large to inline. Pass savePath to write it to disk.`);
      }
      return {
        filename,
        contentType: att.contentType,
        size: att.size,
        contentBase64: att.content.toString("base64"),
      };
    });
  }

  // ----- generic write ops (folder-based) -----

  async modifyLabels(_id: string, _add: string[], _remove: string[]): Promise<MutationResult> {
    throw new Error("This provider is folder-based (no labels). Use move to relocate a message.");
  }

  private async setFlag(id: string, flag: string, on: boolean): Promise<MutationResult> {
    return this.withMessage(id, async (client, uid) => {
      if (on) await client.messageFlagsAdd(String(uid), [flag], { uid: true });
      else await client.messageFlagsRemove(String(uid), [flag], { uid: true });
      return { id, flag, on };
    });
  }

  markRead(id: string, on: boolean): Promise<MutationResult> {
    return this.setFlag(id, "\\Seen", on);
  }

  star(id: string, on: boolean): Promise<MutationResult> {
    return this.setFlag(id, "\\Flagged", on);
  }

  async archive(id: string): Promise<MutationResult> {
    const boxes = await this.boxes();
    const archive = this.requireBox(boxes, "archive");
    return this.move(id, archive);
  }

  async move(id: string, target: string): Promise<MutationResult> {
    return this.withMessage(id, async (client, uid) => {
      await client.messageMove(String(uid), target, { uid: true });
      return { id, movedTo: target };
    });
  }

  async trash(id: string): Promise<MutationResult> {
    const boxes = await this.boxes();
    const trash = this.requireBox(boxes, "trash");
    return this.withMessage(id, async (client, uid) => {
      await client.messageMove(String(uid), trash, { uid: true });
      return { id, trashed: true };
    });
  }

  async delete(id: string): Promise<MutationResult> {
    // Standard IMAP permanent delete: \Deleted + EXPUNGE in place.
    return this.withMessage(id, async (client, uid) => {
      await client.messageDelete(String(uid), { uid: true });
      return { id, deleted: true };
    });
  }

  // ----- bulk (query-first) -----

  /** Fetch fields used to build the preview sample. Gmail overrides to include X-GM ids. */
  protected readonly summaryQuery: FetchQueryObject = BASE_SUMMARY_QUERY;

  /** IMAP SEARCH criteria for a query. Gmail overrides with { gmraw }. Empty = whole mailbox. */
  protected searchCriteria(query?: string): SearchObject {
    return query && query.trim() ? { text: query.trim() } : { all: true };
  }

  /** Turn a fetched message into a summary with a usable id. Gmail overrides (X-GM-MSGID). */
  protected formatFetched(msg: FetchMsg, scope: string, uidValidity: bigint | number | string): MessageSummary {
    const s = formatSummary(msg);
    s.id = this.makeId(scope, uidValidity, msg.uid);
    return s;
  }

  /** Apply one action to a UID sequence set within the currently-open mailbox. */
  protected async applyAction(client: ImapFlow, range: string, action: BulkAction): Promise<void> {
    switch (action.kind) {
      case "flags":
        if (action.add && action.add.length)
          await client.messageFlagsAdd(range, action.add, { uid: true, useLabels: action.useLabels });
        if (action.remove && action.remove.length)
          await client.messageFlagsRemove(range, action.remove, { uid: true, useLabels: action.useLabels });
        break;
      case "move":
        await client.messageMove(range, action.target, { uid: true });
        break;
      case "delete":
        await client.messageDelete(range, { uid: true });
        break;
    }
  }

  /**
   * The shared batch engine: open one mailbox, SEARCH the whole matching set (no
   * truncation), then either preview (dryRun / needsConfirm) or act on every match
   * in chunked IMAP commands. UIDs are captured up-front, so moves/deletes on one
   * chunk never disturb a later chunk's ids. Partial failures are reported, not hidden.
   */
  protected async runBulk(action: BulkAction, opts: BulkOpts, requireConfirm = false): Promise<BulkResult> {
    const client = await this.getClient();
    const boxes = await this.boxes();
    const mailbox = opts.mailbox ?? this.searchScope(boxes);
    return withMailbox(client, mailbox, async () => {
      const uidValidity = client.mailbox ? client.mailbox.uidValidity : 0;
      const uids = (await client.search(this.searchCriteria(opts.query), { uid: true })) || [];
      const matched = uids.length;

      if (matched === 0) {
        return { mailbox, matched: 0, affected: 0, remaining: 0, done: true, dryRun: Boolean(opts.dryRun), sample: [], failed: [], message: "Nothing matched." };
      }

      const sampleMsgs = await client.fetchAll(toRange(uids.slice(-BULK_SAMPLE)), this.summaryQuery, { uid: true });
      const sample = sampleMsgs.map((m) => this.formatFetched(m, mailbox, uidValidity)).sort(byDateDesc);

      if (opts.dryRun) {
        return { mailbox, matched, affected: 0, remaining: matched, done: false, dryRun: true, sample, failed: [] };
      }
      if ((requireConfirm || matched > BULK_CONFIRM_OVER) && opts.confirm !== true) {
        return {
          mailbox,
          matched,
          affected: 0,
          remaining: matched,
          done: false,
          dryRun: false,
          needsConfirm: true,
          message: `${matched} message(s) matched in ${mailbox}. Re-run with confirm:true to proceed, or dryRun:true to preview.`,
          sample,
          failed: [],
        };
      }

      // Removing ops (move/trash/delete) leave the search scope once acted, so a
      // capped batch is safely resumable by re-running. Flag ops don't self-narrow
      // (capping them would loop), and STOREs are cheap, so they run uncapped.
      const selfNarrows = action.kind !== "flags";
      const cap = selfNarrows ? Math.max(1, opts.max ?? DEFAULT_BULK_MAX) : matched;
      const batch = uids.slice(0, cap);

      const failed: { uid: number; error: string }[] = [];
      let affected = 0;
      for (const chunk of chunkUids(batch)) {
        try {
          await this.applyAction(client, toRange(chunk), action);
          affected += chunk.length;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          for (const uid of chunk) failed.push({ uid, error });
        }
      }
      const done = batch.length === matched;
      const remaining = matched - affected;
      let message: string | undefined;
      if (!done) {
        message = `Acted on ${affected} of ${matched} in ${mailbox}; ~${matched - batch.length} beyond this batch. Re-run the same call to continue until done:true.`;
      } else if (failed.length) {
        message = `Processed all ${matched}; ${failed.length} failed (see failed[]).`;
      }
      return { mailbox, matched, affected, remaining, done, dryRun: false, sample, failed, message };
    });
  }

  bulkMarkRead(on: boolean, opts: BulkOpts): Promise<BulkResult> {
    return this.runBulk({ kind: "flags", add: on ? ["\\Seen"] : undefined, remove: on ? undefined : ["\\Seen"] }, opts);
  }

  bulkModifyLabels(_add: string[], _remove: string[], _opts: BulkOpts): Promise<BulkResult> {
    throw new Error("This provider is folder-based (no labels). Use bulkMove to relocate messages.");
  }

  bulkMove(target: string, opts: BulkOpts): Promise<BulkResult> {
    return this.runBulk({ kind: "move", target }, opts);
  }

  async bulkTrash(opts: BulkOpts): Promise<BulkResult> {
    const trash = this.requireBox(await this.boxes(), "trash");
    return this.runBulk({ kind: "move", target: trash }, opts);
  }

  async bulkDelete(opts: BulkOpts): Promise<BulkResult> {
    if (!opts.mailbox) {
      throw new Error("bulkDelete requires an explicit mailbox — refusing to permanently delete without one.");
    }
    return this.runBulk({ kind: "delete" }, opts, true);
  }

  async bulkEmpty(which: "trash" | "junk", opts: BulkOpts): Promise<BulkResult> {
    const mailbox = this.requireBox(await this.boxes(), which);
    return this.runBulk({ kind: "delete" }, { ...opts, mailbox }, true);
  }
}
