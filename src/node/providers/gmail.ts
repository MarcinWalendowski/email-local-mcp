import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FetchQueryObject, ImapFlow, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import {
  type FetchMsg,
  ImapProvider,
  MAX_INLINE_ATTACHMENT,
  NotFoundError,
  byDateDesc,
  formatSummary,
  withMailbox,
} from "./imap.js";
import type { MailCredential } from "../credential.js";
import type {
  AttachmentResult,
  BulkOpts,
  BulkResult,
  ConnectionConfig,
  FullMessage,
  MessageSummary,
  MutationResult,
  ProviderCapabilities,
} from "../../core/index.js";

// Gmail exposes X-GM-MSGID / X-GM-THRID / labels via these fetch keys.
const GMAIL_SUMMARY_QUERY = {
  uid: true,
  envelope: true,
  emailId: true,
  threadId: true,
  labels: true,
  flags: true,
  internalDate: true,
  size: true,
} as const;

const GMAIL_FULL_QUERY = { ...GMAIL_SUMMARY_QUERY, source: true } as const;

/**
 * Gmail provider: IMAP + Gmail's X-GM-* extensions. This is the original,
 * battle-tested Gmail implementation moved behind the MailProvider interface —
 * search via X-GM-RAW, stable X-GM-MSGID ids, X-GM-THRID threads, and Gmail's
 * label model (archive = drop \Inbox). Only the ops that differ from plain IMAP
 * are overridden; connection, SMTP, drafts, folder create/list, and verify are
 * inherited unchanged from ImapProvider.
 */
// Re-exported from core (see the note there): the capabilities belong to Gmail
// the service, and both hosts must answer identically.
export { GMAIL_CAPABILITIES } from "../../core/index.js";
import { GMAIL_CAPABILITIES } from "../../core/index.js";

export class GmailProvider extends ImapProvider {
  readonly capabilities: ProviderCapabilities = GMAIL_CAPABILITIES;

  constructor(email: string, conn: ConnectionConfig, credential?: MailCredential) {
    super(email, conn, "gmail", credential);
  }

  /**
   * Find where a Gmail message actually lives and return the mailbox + UID.
   * A single X-GM-RAW/emailId SEARCH only returns hits in the *selected* mailbox,
   * and All Mail excludes Spam & Trash — so we probe All Mail, then Spam, Trash,
   * and Inbox. This is what lets single-message ops touch Spam/Trash at all.
   * (ImapFlow maps `emailId` to X-GM-MSGID when the server advertises X-GM-EXT-1.)
   */
  private async resolveAnywhere(id: string): Promise<{ mailbox: string; uid: number } | null> {
    const client = await this.getClient();
    const boxes = await this.boxes();
    const candidates = [boxes.all, boxes.junk, boxes.trash, boxes.inbox].filter(
      (b): b is string => Boolean(b),
    );
    const seen = new Set<string>();
    for (const box of candidates) {
      if (seen.has(box)) continue;
      seen.add(box);
      const uid = await withMailbox(client, box, async () => {
        const uids = await client.search({ emailId: id }, { uid: true });
        return uids && uids.length ? uids[uids.length - 1] : undefined;
      });
      if (uid !== undefined) return { mailbox: box, uid };
    }
    return null;
  }

  /** Resolve the id, then run `fn` with the mailbox it lives in already selected. */
  private async withResolved<T>(
    id: string,
    fn: (client: ImapFlow, uid: number, mailbox: string) => Promise<T>,
  ): Promise<T> {
    const found = await this.resolveAnywhere(id);
    if (!found) throw new NotFoundError(id);
    const client = await this.getClient();
    return withMailbox(client, found.mailbox, () => fn(client, found.uid, found.mailbox));
  }

  // ---------- read ----------

  async search(query: string, limit = 25, folder?: string): Promise<MessageSummary[]> {
    const client = await this.getClient();
    const boxes = await this.boxes();
    const scope = folder ?? this.searchScope(boxes);
    return withMailbox(client, scope, async () => {
      const uids = await client.search({ gmraw: query }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const chosen = uids.slice(-Math.max(1, limit)); // newest UIDs are highest
      const msgs = await client.fetchAll(chosen, GMAIL_SUMMARY_QUERY, { uid: true });
      return msgs.map(formatSummary).sort(byDateDesc);
    });
  }

  async getMessage(id: string): Promise<FullMessage> {
    return this.withResolved(id, async (client, uid) => {
      const msg = await client.fetchOne(String(uid), GMAIL_FULL_QUERY, { uid: true });
      if (!msg) throw new NotFoundError(id);
      const summary = formatSummary(msg);
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

  async getThread(threadId: string): Promise<MessageSummary[]> {
    const client = await this.getClient();
    const boxes = await this.boxes();
    return withMailbox(client, this.searchScope(boxes), async () => {
      const uids = await client.search({ threadId }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const msgs = await client.fetchAll(uids, GMAIL_SUMMARY_QUERY, { uid: true });
      return msgs.map(formatSummary).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    });
  }

  async getAttachment(id: string, index: number, savePath?: string): Promise<AttachmentResult> {
    return this.withResolved(id, async (client, uid) => {
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

  // ---------- update (label-based) ----------

  async modifyLabels(id: string, add: string[] = [], remove: string[] = []): Promise<MutationResult> {
    return this.withResolved(id, async (client, uid) => {
      if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true, useLabels: true });
      if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true, useLabels: true });
      return { id, added: add, removed: remove };
    });
  }

  private async flagMessage(id: string, flag: string, on: boolean): Promise<MutationResult> {
    return this.withResolved(id, async (client, uid) => {
      if (on) await client.messageFlagsAdd(String(uid), [flag], { uid: true });
      else await client.messageFlagsRemove(String(uid), [flag], { uid: true });
      return { id, flag, on };
    });
  }

  markRead(id: string, on: boolean): Promise<MutationResult> {
    return this.flagMessage(id, "\\Seen", on);
  }

  // Gmail surfaces the IMAP \Flagged flag as a star.
  star(id: string, on: boolean): Promise<MutationResult> {
    return this.flagMessage(id, "\\Flagged", on);
  }

  /** Archive = drop the Inbox label (Gmail keeps the message in All Mail). */
  archive(id: string): Promise<MutationResult> {
    return this.modifyLabels(id, [], ["\\Inbox"]);
  }

  /** Move = apply a label and remove from the Inbox (Gmail is label-based). */
  move(id: string, targetLabel: string): Promise<MutationResult> {
    return this.modifyLabels(id, [targetLabel], ["\\Inbox"]);
  }

  // ---------- delete ----------

  async trash(id: string): Promise<MutationResult> {
    const trash = this.requireBox(await this.boxes(), "trash");
    return this.withResolved(id, async (client, uid, mailbox) => {
      if (mailbox === trash) return { id, trashed: true }; // already in Trash
      await client.messageMove(String(uid), trash, { uid: true });
      return { id, trashed: true };
    });
  }

  /**
   * Permanent delete. Gmail only truly deletes on EXPUNGE from within Trash or
   * Spam; a \Deleted + EXPUNGE anywhere else just removes a label. So: if the
   * message already lives in Trash/Spam, expunge it there; otherwise move it into
   * Trash and expunge from there. Never reports success without an actual expunge.
   */
  async delete(id: string): Promise<MutationResult> {
    const boxes = await this.boxes();
    const trash = this.requireBox(boxes, "trash");
    const spam = boxes.junk;

    const found = await this.resolveAnywhere(id);
    if (!found) throw new NotFoundError(id);
    const client = await this.getClient();

    // Already in a mailbox where EXPUNGE is permanent → delete in place.
    if (found.mailbox === trash || (spam && found.mailbox === spam)) {
      return withMailbox(client, found.mailbox, async () => {
        await client.messageDelete(String(found.uid), { uid: true });
        return { id, deleted: true, from: found.mailbox };
      });
    }

    // Elsewhere: move into Trash, then re-locate and EXPUNGE it there.
    await withMailbox(client, found.mailbox, async () => {
      await client.messageMove(String(found.uid), trash, { uid: true });
    });
    return withMailbox(client, trash, async () => {
      const uids = await client.search({ emailId: id }, { uid: true });
      const uid = uids && uids.length ? uids[uids.length - 1] : undefined;
      if (uid === undefined) {
        throw new Error(
          `Delete incomplete: ${id} was moved to Trash but could not be re-located to expunge. Re-run delete, or use empty_trash.`,
        );
      }
      await client.messageDelete(String(uid), { uid: true });
      return { id, deleted: true };
    });
  }

  // ---------- bulk (Gmail overrides) ----------

  protected readonly summaryQuery: FetchQueryObject = GMAIL_SUMMARY_QUERY;

  /** Gmail native search. Empty query = the whole selected mailbox. */
  protected searchCriteria(query?: string): SearchObject {
    return query && query.trim() ? { gmraw: query } : { all: true };
  }

  /** Gmail messages carry a stable X-GM-MSGID (emailId); no composite id needed. */
  protected formatFetched(msg: FetchMsg): MessageSummary {
    return formatSummary(msg);
  }

  /**
   * No id for a Gmail draft. Every other id this provider hands out is an
   * X-GM-MSGID, and the APPEND response carries only a UID — so the composite the
   * base class would build is the one id shape `getMessage` here cannot resolve.
   * Null says "no handle" instead of handing back one that fails on use.
   */
  protected draftId(): string | null {
    return null;
  }

  bulkModifyLabels(add: string[], remove: string[], opts: BulkOpts): Promise<BulkResult> {
    return this.runBulk({ kind: "flags", add, remove, useLabels: true }, opts);
  }

  /** Gmail move = apply the label and drop \Inbox (mirrors single-message move()). */
  bulkMove(target: string, opts: BulkOpts): Promise<BulkResult> {
    return this.runBulk({ kind: "flags", add: [target], remove: ["\\Inbox"], useLabels: true }, opts);
  }

  async bulkDelete(opts: BulkOpts): Promise<BulkResult> {
    const boxes = await this.boxes();
    const trash = this.requireBox(boxes, "trash");
    const { mailbox } = opts;
    if (!mailbox) {
      throw new Error(
        "bulkDelete requires an explicit mailbox. Use empty_trash / empty_spam, or bulk_trash then empty_trash.",
      );
    }
    if (mailbox !== trash && !(boxes.junk && mailbox === boxes.junk)) {
      throw new Error(
        `On Gmail, permanent delete only works inside Trash or Spam (EXPUNGE elsewhere just removes a label). ` +
          `To permanently delete matches in "${mailbox}": bulk_trash them, then empty_trash.`,
      );
    }
    return this.runBulk({ kind: "delete" }, opts, true);
  }
}
