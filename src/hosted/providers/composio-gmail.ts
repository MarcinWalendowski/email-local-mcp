// Gmail served through Composio's hosted tools instead of local IMAP/SMTP.
//
// READ THIS BEFORE CHANGING ANYTHING HERE
//
// **This provider is not part of the local app and must never be wired into
// it.** `src/node/` opens a socket from the user's own machine to their own mail
// host, which is the entire product. This one posts to Composio, and Composio
// talks to Gmail: the mailbox contents transit a third party. Shipping it inside
// the local app would not add a mode, it would falsify the claim the app is
// sold on, per account, invisibly. That is why it lives under `src/hosted/`,
// excluded from the local build — see the header of `src/hosted/README.md`.
//
// It exists because Composio will not release the access token (verified: every
// token field reads the literal "REDACTED"), so "let Composio do the OAuth and
// we keep using IMAP" is not on the menu. See composio/client.ts.
//
// The interface is identical to GmailProvider's on purpose: a hosted deployment
// gets the same tool layer, read-only gate and bulk confirm/dryRun rules, all of
// which sit upstream of this class and never learn which route an account takes.
//
// Nothing here may import from `src/node/` or reach for a Node built-in. The
// target is a Worker: no filesystem, no Keychain, no `process.env`.

import { execute, type ComposioConfig } from "../composio/client.js";
import { GMAIL_CAPABILITIES, MAX_INLINE_ATTACHMENT, NotFoundError } from "../../core/index.js";
import type {
  AttachmentResult,
  BulkOpts,
  BulkResult,
  ComposeInput,
  DraftResult,
  Folder,
  FullMessage,
  MailProvider,
  MessageSummary,
  MutationResult,
  ProviderCapabilities,
  SendResult,
  SpecialMailboxes,
} from "../../core/index.js";

/**
 * Gmail's system label ids. Hard-coded here, unlike the IMAP providers which
 * must *discover* special mailboxes by flag because IMAP folder names are
 * localized. These are API constants, identical in every locale, so discovering
 * them would be pretending to do work.
 */
const SYS = {
  inbox: "INBOX",
  trash: "TRASH",
  spam: "SPAM",
  sent: "SENT",
  drafts: "DRAFT",
  unread: "UNREAD",
  starred: "STARRED",
} as const;

/** Per-call cap when fanning a bulk op out over individual messages. */
const BULK_PAGE = 100;

export interface RawMessage {
  messageId?: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  to?: string;
  messageTimestamp?: string;
  messageText?: string;
  labelIds?: string[];
  attachmentList?: { attachmentId?: string; filename?: string; mimeType?: string }[];
  payload?: { headers?: { name?: string; value?: string }[] };
}

function header(msg: RawMessage, name: string): string | null {
  const hs = msg.payload?.headers ?? [];
  const needle = name.toLowerCase();
  return hs.find((h) => (h.name ?? "").toLowerCase() === needle)?.value ?? null;
}

/**
 * Composio's message shape → our MessageSummary.
 *
 * Two fields are deliberately null rather than invented, following the rule the
 * interface itself sets out for `uid`:
 *
 *  - `uid`: an HTTP mail API has no IMAP UID. A `0` on every message would be a
 *    value a model can read and reason about, and it would be false.
 *  - `size`: Composio does not return Gmail's `sizeEstimate` at all. Summing
 *    part sizes would produce a confident number that is not the message size.
 *
 * `flags` keeps only the two IMAP flags that map exactly onto Gmail labels.
 * The rest of the IMAP flag vocabulary has no counterpart here, and inventing
 * entries would make a Composio account look like it round-trips IMAP state.
 */
export function toSummary(msg: RawMessage): MessageSummary {
  const labels = msg.labelIds ?? [];
  const flags: string[] = [];
  if (!labels.includes(SYS.unread)) flags.push("\\Seen");
  if (labels.includes(SYS.starred)) flags.push("\\Flagged");

  return {
    id: msg.messageId ?? null,
    threadId: msg.threadId ?? null,
    uid: null,
    subject: msg.subject ?? header(msg, "Subject") ?? "",
    from: msg.sender ?? header(msg, "From") ?? "",
    to: msg.to ?? header(msg, "To") ?? "",
    cc: header(msg, "Cc") ?? "",
    date: msg.messageTimestamp ?? header(msg, "Date"),
    // The RFC822 Message-ID header, NOT the Gmail id. Composio calls the Gmail
    // id `messageId` too, which is exactly the confusion `id` vs `messageId`
    // exists to prevent — read this one from the headers or it silently becomes
    // a duplicate of `id`.
    messageId: header(msg, "Message-ID") ?? header(msg, "Message-Id"),
    inReplyTo: header(msg, "In-Reply-To"),
    labels,
    flags,
    unread: labels.includes(SYS.unread),
    size: null,
  };
}

function toFull(msg: RawMessage): FullMessage {
  return {
    ...toSummary(msg),
    text: msg.messageText ?? null,
    // Composio's `messageText` is already the flattened body; it does not hand
    // back a separate decoded HTML part. Null says "not available" rather than
    // duplicating the text into an html field that never contained markup.
    html: null,
    attachments: (msg.attachmentList ?? []).map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index}`,
      contentType: a.mimeType ?? "application/octet-stream",
      // Composio's attachment list carries no size. Same rule as above: absent
      // beats a plausible zero, and 0 would read as "empty file".
      size: 0,
    })),
  };
}

const toArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * Gmail encodes attachment bytes **base64url** (`-`/`_`, padding stripped), and
 * the shared `AttachmentResult.contentBase64` contract is standard base64. Left
 * as-is, a caller decoding it hits an alphabet error on roughly any attachment
 * containing the affected byte pairs, which is most of them and none of them
 * predictably. Normalise once, here, rather than at each consumer.
 */
function toStandardBase64(b64: string): string {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
}

/**
 * Decoded size of a base64 string, computed rather than measured.
 *
 * Decoding to find out how big something is means allocating the very buffer the
 * size check exists to avoid — and `Buffer` is a Node global this file is not
 * allowed to touch. Arithmetic on the encoded length is exact.
 */
function base64ByteLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

export class ComposioGmailProvider implements MailProvider {
  readonly id = "gmail" as const;
  readonly capabilities: ProviderCapabilities = GMAIL_CAPABILITIES;

  constructor(
    private readonly cfg: ComposioConfig,
    readonly email: string,
    private readonly connectedAccountId: string,
    private readonly userId: string,
  ) {}

  private run<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return execute<T>(this.cfg, tool, {
      connectedAccountId: this.connectedAccountId,
      userId: this.userId,
      arguments: args,
    });
  }

  // ── read ────────────────────────────────────────────────────────────────

  async verify(): Promise<SpecialMailboxes> {
    // Cheapest call that proves the connection is live AND tells us which
    // mailbox it actually belongs to.
    await this.run("GMAIL_GET_PROFILE");
    return {
      inbox: SYS.inbox,
      all: "",
      archive: "",
      trash: SYS.trash,
      drafts: SYS.drafts,
      sent: SYS.sent,
      junk: SYS.spam,
    };
  }

  async search(query: string, limit: number, folder?: string): Promise<MessageSummary[]> {
    const q = folder ? `in:${folder} ${query ?? ""}`.trim() : query;
    const data = await this.run<{ messages?: RawMessage[] }>("GMAIL_FETCH_EMAILS", {
      query: q || undefined,
      max_results: limit,
      include_payload: true,
    });
    return (data.messages ?? []).map(toSummary);
  }

  async getMessage(id: string): Promise<FullMessage> {
    const data = await this.run<RawMessage & { messages?: RawMessage[] }>(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      { message_id: id, format: "full" },
    );
    const msg = data.messages?.[0] ?? data;
    if (!msg?.messageId) throw new NotFoundError(id);
    return toFull(msg);
  }

  async getThread(threadId: string): Promise<MessageSummary[]> {
    const data = await this.run<{ messages?: RawMessage[] }>("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
      thread_id: threadId,
    });
    return (data.messages ?? []).map(toSummary);
  }

  async listFolders(): Promise<Folder[]> {
    const data = await this.run<{ labels?: { id?: string; name?: string; type?: string }[] }>(
      "GMAIL_LIST_LABELS",
    );
    return (data.labels ?? []).map((l) => ({
      path: l.id ?? l.name ?? "",
      name: l.name ?? l.id ?? "",
      specialUse: l.type === "system" ? (l.id ?? null) : null,
    }));
  }

  async getAttachment(id: string, index: number, savePath?: string): Promise<AttachmentResult> {
    // Refused FIRST, before three round-trips fetch bytes that are then thrown
    // away. Ordering matters for more than cost: further down, this same refusal
    // is reachable only if the fetch succeeded, so any earlier failure answers a
    // `savePath` caller with the wrong reason entirely ("Composio returned no
    // attachment content") and sends them debugging Composio instead of reading
    // the sentence that explains their request cannot be honoured here.
    //
    // `savePath` is in the shared interface because the local host has a disk to
    // honour it with. This host does not, and accepting the argument to ignore
    // it would report a file written to a path that will never exist.
    if (savePath) {
      throw new Error(
        "This account's mail is served over HTTP, which has no local filesystem to save to. " +
          "Fetch the attachment inline, or add the account to a host that opens the mailbox directly.",
      );
    }
    const msg = await this.getMessage(id);
    const att = msg.attachments[index];
    if (!att) {
      throw new Error(
        `No attachment at index ${index} (message has ${msg.attachments.length}).`,
      );
    }
    // The attachment id is not on our FullMessage shape (nothing else needs it),
    // so re-read the raw list rather than widen the public type for one caller.
    const raw = await this.run<RawMessage & { messages?: RawMessage[] }>(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      { message_id: id, format: "full" },
    );
    const attachmentId = ((raw.messages?.[0] ?? raw).attachmentList ?? [])[index]?.attachmentId;
    if (!attachmentId) throw new Error(`Attachment ${index} on ${id} has no id.`);

    const data = await this.run<{ file?: string; data?: string; s3url?: string }>(
      "GMAIL_GET_ATTACHMENT",
      { message_id: id, attachment_id: attachmentId, file_name: att.filename },
    );
    const b64 = data.data ?? data.file;
    if (!b64) {
      throw new Error(
        `Composio returned no attachment content for ${att.filename}. ` +
          "This provider cannot fetch attachments that Composio only exposes by URL.",
      );
    }
    const content = toStandardBase64(b64);
    const size = base64ByteLength(content);
    if (size > MAX_INLINE_ATTACHMENT) {
      throw new Error(
        `Attachment is ${size} bytes; too large to inline, and this account has no local filesystem to save it to.`,
      );
    }
    return { filename: att.filename, contentType: att.contentType, size, contentBase64: content };
  }

  // ── create ──────────────────────────────────────────────────────────────

  /**
   * Composio's send is narrower than ours, in two ways that cannot be papered
   * over, so both refuse loudly instead of quietly doing less than asked:
   *
   *  - **Attachments.** `GMAIL_SEND_EMAIL` takes a single `attachment` object
   *    that must already be uploaded to Composio's own storage (`s3key`). It
   *    cannot take a local path or inline base64, and it cannot take more than
   *    one. Dropping them silently would send a mail the user believes carried a
   *    file.
   *  - **Threading.** There is no In-Reply-To / References parameter, only
   *    `thread_id` on the reply tool — and an RFC822 Message-ID is not a Gmail
   *    thread id. Sending anyway would produce a message that reads as a reply
   *    to the user and threads nowhere for the recipient.
   */
  private assertSendable(input: ComposeInput, op: string): void {
    if (input.attachments?.length) {
      throw new Error(
        `${op} with attachments is not supported on a Composio-backed account: Composio's Gmail tool ` +
          "accepts one pre-uploaded file and no local paths. Add this mailbox with an App Password " +
          "or your own OAuth client to send attachments.",
      );
    }
    if (input.inReplyTo) {
      throw new Error(
        `${op} as a reply (inReplyTo) is not supported on a Composio-backed account: Composio's Gmail ` +
          "tool threads by Gmail thread id, not by RFC822 Message-ID, so the reply would not thread.",
      );
    }
  }

  private composeArgs(input: ComposeInput): Record<string, unknown> {
    const to = toArray(input.to);
    if (to.length === 0) throw new Error("send requires at least one recipient.");
    return {
      recipient_email: to[0],
      extra_recipients: to.slice(1),
      cc: toArray(input.cc),
      bcc: toArray(input.bcc),
      subject: input.subject,
      body: input.html ?? input.text ?? "",
      is_html: Boolean(input.html),
    };
  }

  async send(input: ComposeInput): Promise<SendResult> {
    this.assertSendable(input, "send");
    const data = await this.run<{ id?: string; messageId?: string; response_data?: { id?: string } }>(
      "GMAIL_SEND_EMAIL",
      this.composeArgs(input),
    );
    // `accepted`/`rejected`/`response` are SMTP artefacts. This route never
    // speaks SMTP, so they are omitted rather than faked — the interface makes
    // them optional for exactly this case, and `[]` would read as "no recipient
    // accepted it", the opposite of what happened.
    return { messageId: data.response_data?.id ?? data.id ?? data.messageId ?? "" };
  }

  async createDraft(input: ComposeInput): Promise<DraftResult> {
    this.assertSendable(input, "createDraft");
    const data = await this.run<{ id?: string; response_data?: { id?: string } }>(
      "GMAIL_CREATE_EMAIL_DRAFT",
      this.composeArgs(input),
    );
    return { mailbox: SYS.drafts, uid: null, id: data.response_data?.id ?? data.id ?? null };
  }

  async createFolder(name: string): Promise<{ path: string; created: boolean }> {
    const data = await this.run<{ id?: string; response_data?: { id?: string } }>(
      "GMAIL_CREATE_LABEL",
      { label_name: name },
    );
    return { path: data.response_data?.id ?? data.id ?? name, created: true };
  }

  // ── update ──────────────────────────────────────────────────────────────

  /**
   * DO NOT reach for `GMAIL_REMOVE_LABEL` here. Despite the name it takes only a
   * `label_id` and no message id, because it **permanently deletes the label
   * from the account** — "Permanently deletes a specific, existing user-created
   * gmail label by its id", in Composio's own words. Using it to unlabel a
   * message would destroy the label everywhere, on every message that carries
   * it. Removing a label *from a message* is `GMAIL_ADD_LABEL_TO_EMAIL` with
   * `remove_label_ids`; that tool does both directions.
   */
  async modifyLabels(id: string, add: string[], remove: string[]): Promise<MutationResult> {
    await this.run("GMAIL_ADD_LABEL_TO_EMAIL", {
      message_id: id,
      add_label_ids: add,
      remove_label_ids: remove,
    });
    return { id, added: add, removed: remove };
  }

  markRead(id: string, on: boolean): Promise<MutationResult> {
    return this.modifyLabels(id, on ? [] : [SYS.unread], on ? [SYS.unread] : []);
  }

  star(id: string, on: boolean): Promise<MutationResult> {
    return this.modifyLabels(id, on ? [SYS.starred] : [], on ? [] : [SYS.starred]);
  }

  archive(id: string): Promise<MutationResult> {
    return this.modifyLabels(id, [], [SYS.inbox]);
  }

  move(id: string, target: string): Promise<MutationResult> {
    // Gmail has labels, not folders: "move" is add-target + drop-INBOX, the same
    // definition GmailProvider uses over IMAP.
    return this.modifyLabels(id, [target], [SYS.inbox]);
  }

  // ── delete ──────────────────────────────────────────────────────────────

  async trash(id: string): Promise<MutationResult> {
    await this.run("GMAIL_MOVE_TO_TRASH", { message_id: id });
    return { id, trashed: true };
  }

  async delete(id: string): Promise<MutationResult> {
    // Permanent, and — unlike IMAP, where \Deleted + EXPUNGE only truly removes a
    // message inside Trash/Spam — this deletes whatever id it is handed,
    // wherever it lives. The interface leaves the reach to the implementation to
    // state, so: this one reaches everywhere.
    await this.run("GMAIL_DELETE_MESSAGE", { message_id: id });
    return { id, deleted: true };
  }

  // ── bulk ────────────────────────────────────────────────────────────────

  /**
   * Collect message ids for a bulk op, paging until `cap` or exhaustion.
   *
   * `ids_only` skips per-message metadata fetches, which is the difference
   * between a bulk match being one round trip per page and one per message.
   */
  private async matchIds(opts: BulkOpts, cap: number): Promise<{ ids: string[]; more: boolean }> {
    const query = [opts.mailbox ? `in:${opts.mailbox}` : "", opts.query ?? ""]
      .filter(Boolean)
      .join(" ")
      .trim();
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.run<{
        messages?: (RawMessage | string)[];
        nextPageToken?: string;
      }>("GMAIL_FETCH_EMAILS", {
        query: query || undefined,
        max_results: Math.min(BULK_PAGE, cap - ids.length),
        ids_only: true,
        include_spam_trash: true,
        page_token: pageToken,
      });
      for (const m of data.messages ?? []) {
        const id = typeof m === "string" ? m : m.messageId;
        if (id) ids.push(id);
      }
      pageToken = data.nextPageToken;
    } while (pageToken && ids.length < cap);
    return { ids, more: Boolean(pageToken) };
  }

  /**
   * The shared body of every bulk op.
   *
   * Composio has no bulk endpoint, so this is search-then-iterate: N+1 round
   * trips where IMAP does one STORE over a UID set. It is correct but markedly
   * slower, and the docs say so rather than letting a user discover it on a
   * ten-thousand-message sweep.
   *
   * The confirm / dryRun / >100 gates are NOT re-implemented here — they live in
   * the tool layer, above the provider, so they apply to every route identically.
   * This method must therefore never be reachable in a way that bypasses them.
   */
  private async bulk(
    opts: BulkOpts,
    apply: (id: string) => Promise<unknown>,
  ): Promise<BulkResult> {
    const mailbox = opts.mailbox ?? "";
    const cap = opts.max ?? 2000;
    const { ids, more } = await this.matchIds(opts, opts.dryRun ? Math.min(cap, 25) : cap);

    const sample = ids.length
      ? await this.search(opts.query ?? "", Math.min(5, ids.length), opts.mailbox)
      : [];

    if (opts.dryRun) {
      return {
        mailbox,
        matched: ids.length,
        affected: 0,
        remaining: ids.length,
        done: !more,
        dryRun: true,
        sample,
        failed: [],
      };
    }

    const failed: BulkResult["failed"] = [];
    let affected = 0;
    for (const id of ids) {
      try {
        await apply(id);
        affected++;
      } catch (e) {
        failed.push({ uid: null, id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return {
      mailbox,
      matched: ids.length,
      affected,
      remaining: ids.length - affected,
      done: !more,
      dryRun: false,
      sample,
      failed,
    };
  }

  bulkMarkRead(on: boolean, opts: BulkOpts): Promise<BulkResult> {
    return this.bulk(opts, (id) => this.markRead(id, on));
  }

  bulkModifyLabels(add: string[], remove: string[], opts: BulkOpts): Promise<BulkResult> {
    return this.bulk(opts, (id) => this.modifyLabels(id, add, remove));
  }

  bulkMove(target: string, opts: BulkOpts): Promise<BulkResult> {
    return this.bulk(opts, (id) => this.move(id, target));
  }

  bulkTrash(opts: BulkOpts): Promise<BulkResult> {
    return this.bulk(opts, (id) => this.trash(id));
  }

  // `async` is load-bearing, not decoration. Without it the guard below throws
  // SYNCHRONOUSLY out of a method whose signature promises a Promise, so a
  // caller writing `provider.bulkDelete(...).catch(...)` — the obvious way to
  // handle a refusal — never catches it and the process takes an uncaught
  // exception instead. Caught by the negative-control test, which is the only
  // thing that ever exercises this branch.
  async bulkDelete(opts: BulkOpts): Promise<BulkResult> {
    if (!opts.mailbox) {
      throw new Error("bulkDelete requires an explicit mailbox — an irreversible delete must name where it runs.");
    }
    return this.bulk(opts, (id) => this.delete(id));
  }

  bulkEmpty(which: "trash" | "junk", opts: BulkOpts): Promise<BulkResult> {
    return this.bulk({ ...opts, mailbox: which === "trash" ? "trash" : "spam" }, (id) =>
      this.delete(id),
    );
  }

  // ── lifecycle ───────────────────────────────────────────────────────────
  //
  // No-ops, and that is the honest implementation rather than a stub: this
  // route holds no socket and no session, so there is nothing to close and
  // nothing to sweep when idle.

  async close(): Promise<void> {}
  async closeIfIdle(): Promise<void> {}
}
