// The tool vocabulary — names, schemas, descriptions, and the argument-to-
// provider plumbing. Portable by construction: it depends on the MailProvider
// interface, zod and the MCP SDK, and on nothing that only exists in Node. Every
// host-specific concern (which accounts exist, where credentials live, how a
// provider is built) arrives through the MailHost seam.
//
// `tsconfig.core.json` type-checks this directory with no `@types/node` and a
// DOM/Workers lib, so importing a Node API here is a compile error rather than a
// discovery made later, in a Worker, at runtime.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "./result.js";
import type { MailHost } from "./accounts.js";
import type {
  BulkOpts,
  ComposeInput,
  ConnectionConfig,
  MailProvider,
  ProviderId,
} from "./provider.js";

const account = z
  .string()
  .optional()
  .describe(
    "Email address to act on (any connected provider). Omit to use the default account.",
  );
// Named *Param to avoid shadowing the local `id` bindings used in the write helpers
// below; the wire field is `id` via the explicit keys in each inputSchema.
const msgIdParam = z
  .string()
  .describe(
    "Opaque message id (the `id` field returned by search_messages or get_message; Gmail: X-GM-MSGID). Pass it back verbatim; never construct one. Not the same as `messageId`, which is the RFC822 Message-ID header.",
  );

const composeShape = {
  account,
  to: z.union([z.string(), z.array(z.string())]).describe("Recipient address(es)."),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string(),
  text: z.string().optional().describe("Plain-text body."),
  html: z.string().optional().describe("HTML body (optional)."),
  inReplyTo: z
    .string()
    .optional()
    .describe(
      "RFC822 Message-ID being replied to; sets In-Reply-To/References so the reply threads correctly.",
    ),
  attachments: z
    .array(
      z.object({
        filename: z.string().optional(),
        path: z.string().optional().describe("Absolute path to a local file to attach."),
        contentBase64: z.string().optional().describe("Base64 content (alternative to path)."),
        contentType: z.string().optional(),
      }),
    )
    .optional(),
};

// Shared input for the query-first bulk tools.
const bulkShape = {
  account,
  query: z
    .string()
    .optional()
    .describe(
      "What to match. On Gmail this is native search syntax (e.g. 'older_than:1y is:unread'); on other providers a text match. Omit to match the whole mailbox.",
    ),
  mailbox: z
    .string()
    .optional()
    .describe("Mailbox/label to run in (e.g. '[Gmail]/Spam'). Omit for the account's whole-mail scope (Gmail: All Mail)."),
  dryRun: z.boolean().optional().describe("Preview only: return the matched count + a small sample, changing nothing."),
  confirm: z.boolean().optional().describe("Required to actually run a destructive or large (>100) batch."),
  max: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Cap on messages acted on this call for trash/move/delete/empty (default 2000, keeps calls under the timeout). If the result is done:false, re-run the same call (with confirm:true) to continue until done:true.",
    ),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

const bulkOpts = (a: Args): BulkOpts => ({
  query: a.query,
  mailbox: a.mailbox,
  dryRun: a.dryRun,
  confirm: a.confirm,
  max: a.max,
});

function reg(
  server: McpServer,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  fn: (a: Args) => Promise<unknown>,
): void {
  server.registerTool(name, config, async (a: Args) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  });
}

/**
 * Register the mail tool surface on an MCP server.
 *
 * Every host calls exactly this, which is what makes the tool names, schemas and
 * descriptions identical across deployments by construction rather than by
 * discipline. The only surface that varies is `add_account`, registered solely
 * when the host offers a credential store to put a password into.
 */
export function registerTools(server: McpServer, host: MailHost): void {
  /** Resolve `account`, then assert it accepts writes. Every write tool starts here. */
  const writable = async (account?: string): Promise<string> => {
    const email = await host.resolveEmail(account);
    await host.assertWritable(email);
    return email;
  };

  // ---------- read ----------
  reg(
    server,
    "list_accounts",
    {
      title: "List email accounts",
      description:
        "List the configured email accounts (no secrets), showing each account's provider (gmail / icloud / fastmail / imap), which is default, and which are read-only. Check the provider before assuming labels, threads, or Gmail search syntax are available.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => host.listAccounts(),
  );

  reg(
    server,
    "search_messages",
    {
      title: "Search messages",
      description:
        "Search an account. On Gmail: native Gmail query syntax (e.g. 'from:alice newer_than:7d has:attachment', 'in:anywhere subject:invoice') — All Mail excludes Trash/Spam unless you add 'in:anywhere'. On other providers (icloud / fastmail / imap): a limited server-side text match, so Gmail operators are NOT understood — pass plain text and narrow with the folder param instead. Returns summaries carrying `id` (pass back to act on a message) and `threadId`.",
      inputSchema: {
        account,
        query: z
          .string()
          .describe(
            "Gmail: search query in X-GM-RAW syntax. Other providers: plain text to match, not query syntax.",
          ),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25, newest first)."),
        label: z.string().optional().describe("Restrict to a specific label/mailbox path instead of All Mail."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => (await host.getProvider(await host.resolveEmail(a.account))).search(a.query, a.limit ?? 25, a.label),
  );

  reg(
    server,
    "get_message",
    {
      title: "Get message",
      description:
        "Fetch a full message: headers, plain-text and HTML bodies, and attachment metadata (use get_attachment for bytes).",
      inputSchema: { account, id: msgIdParam },
      annotations: { readOnlyHint: true },
    },
    async (a) => (await host.getProvider(await host.resolveEmail(a.account))).getMessage(a.id),
  );

  reg(
    server,
    "get_thread",
    {
      title: "Get thread",
      description:
        "Fetch all messages in a thread (by threadId), oldest first. Gmail only — other providers cannot resolve threads server-side; fall back to search_messages.",
      inputSchema: {
        account,
        threadId: z
          .string()
          .describe("Opaque thread id — the `threadId` field from search_messages (Gmail: X-GM-THRID)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => (await host.getProvider(await host.resolveEmail(a.account))).getThread(a.threadId),
  );

  reg(
    server,
    "list_labels",
    {
      title: "List labels",
      description: "List all labels/mailboxes for the account, including special-use flags.",
      inputSchema: { account },
      annotations: { readOnlyHint: true },
    },
    async (a) => (await host.getProvider(await host.resolveEmail(a.account))).listFolders(),
  );

  reg(
    server,
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Download one attachment from a message by index. Provide savePath to write it to disk (required for files >5MB); otherwise returns base64.",
      inputSchema: {
        account,
        id: msgIdParam,
        index: z.number().int().min(0).describe("Attachment index from get_message.attachments."),
        savePath: z.string().optional().describe("Absolute path to write the attachment to."),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => (await host.getProvider(await host.resolveEmail(a.account))).getAttachment(a.id, a.index, a.savePath),
  );

  // ---------- create ----------
  reg(
    server,
    "send_message",
    {
      title: "Send email",
      description:
        "Send an email from the account via its provider's SMTP. A copy is filed in Sent automatically. This delivers real mail — confirm before running.",
      inputSchema: composeShape,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).send(a as unknown as ComposeInput);
    },
  );

  reg(
    server,
    "create_draft",
    {
      title: "Create draft",
      description: "Compose a draft and save it to the Drafts mailbox (does not send).",
      inputSchema: composeShape,
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).createDraft(a as unknown as ComposeInput);
    },
  );

  reg(
    server,
    "create_label",
    {
      title: "Create label",
      description:
        "Create a new Gmail label (nested labels use '/', e.g. 'Clients/Acme'). Gmail only — on folder-based providers create a folder and use move instead.",
      inputSchema: { account, name: z.string().describe("Label name/path.") },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).createFolder(a.name);
    },
  );

  // ---------- update ----------
  reg(
    server,
    "modify_labels",
    {
      title: "Modify labels",
      description:
        "Add and/or remove Gmail labels on a message. System labels use a backslash prefix (\\Inbox, \\Starred, \\Important); custom labels use their plain name. Removing \\Inbox archives. Gmail only — on folder-based providers use move or archive.",
      inputSchema: {
        account,
        id: msgIdParam,
        add: z.array(z.string()).optional().describe("Labels to add."),
        remove: z.array(z.string()).optional().describe("Labels to remove."),
      },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).modifyLabels(a.id, a.add ?? [], a.remove ?? []);
    },
  );

  const simpleWrite = (
    name: string,
    title: string,
    description: string,
    op: (provider: MailProvider, id: string) => Promise<unknown>,
    annotations: Record<string, boolean> = {},
  ) =>
    reg(server, name, { title, description, inputSchema: { account, id: msgIdParam }, annotations }, async (a) => {
      const email = await writable(a.account);
      return op(await host.getProvider(email), a.id);
    });

  simpleWrite("mark_read", "Mark read", "Mark a message as read (\\Seen).", (p, id) => p.markRead(id, true));
  simpleWrite("mark_unread", "Mark unread", "Mark a message as unread.", (p, id) => p.markRead(id, false));
  simpleWrite("star", "Star", "Star a message.", (p, id) => p.star(id, true));
  simpleWrite("unstar", "Unstar", "Remove the star from a message.", (p, id) => p.star(id, false));
  simpleWrite("archive", "Archive", "Archive a message (remove it from the Inbox).", (p, id) => p.archive(id));
  simpleWrite(
    "trash_message",
    "Trash message",
    "Move a message to Trash (reversible for ~30 days).",
    (p, id) => p.trash(id),
    { destructiveHint: true },
  );

  reg(
    server,
    "move_message",
    {
      title: "Move message",
      description: "Move a message to a label: applies the target label and removes it from the Inbox.",
      inputSchema: { account, id: msgIdParam, targetLabel: z.string().describe("Label to file the message under.") },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).move(a.id, a.targetLabel);
    },
  );

  reg(
    server,
    "delete_message",
    {
      title: "Permanently delete message",
      description:
        "PERMANENTLY delete a message (moves to Trash then expunges). Irreversible. Requires confirm:true. Prefer trash_message for a reversible delete.",
      inputSchema: {
        account,
        id: msgIdParam,
        confirm: z.boolean().describe("Must be true to permanently delete."),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => {
      if (a.confirm !== true) {
        throw new Error(
          "Refusing permanent delete without confirm:true. Use trash_message for a reversible delete.",
        );
      }
      const email = await writable(a.account);
      return (await host.getProvider(email)).delete(a.id);
    },
  );

  // ---------- bulk (query-first) ----------
  reg(
    server,
    "mark_all_read",
    {
      title: "Mark all matching read",
      description:
        "Mark every message matching a query as read in one pass — e.g. {query:'is:unread', mailbox:'[Gmail]/Spam'}. Reaches Spam/Trash via the mailbox param. Use dryRun:true to preview the count; confirm:true for batches over 100.",
      inputSchema: bulkShape,
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkMarkRead(true, bulkOpts(a));
    },
  );

  reg(
    server,
    "bulk_modify_labels",
    {
      title: "Bulk modify labels",
      description:
        "Add and/or remove labels on every message matching a query (Gmail only). Provide add and/or remove. dryRun:true previews; confirm:true runs batches over 100.",
      inputSchema: {
        ...bulkShape,
        add: z.array(z.string()).optional().describe("Labels to add."),
        remove: z.array(z.string()).optional().describe("Labels to remove."),
      },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkModifyLabels(a.add ?? [], a.remove ?? [], bulkOpts(a));
    },
  );

  reg(
    server,
    "bulk_move",
    {
      title: "Bulk move",
      description:
        "File every message matching a query under a target label (Gmail: adds the label and removes it from the Inbox; other providers: moves to the folder).",
      inputSchema: { ...bulkShape, targetLabel: z.string().describe("Label/folder to file matches under.") },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkMove(a.targetLabel, bulkOpts(a));
    },
  );

  reg(
    server,
    "bulk_trash",
    {
      title: "Bulk trash",
      description:
        "Move every message matching a query to Trash (reversible ~30 days). Requires a query or mailbox. dryRun:true previews; confirm:true runs batches over 100.",
      inputSchema: bulkShape,
      annotations: { destructiveHint: true },
    },
    async (a) => {
      if (!a.query && !a.mailbox) {
        throw new Error("bulk_trash needs a query or mailbox — refusing to trash the whole account by default.");
      }
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkTrash(bulkOpts(a));
    },
  );

  reg(
    server,
    "bulk_delete",
    {
      title: "Bulk permanent delete",
      description:
        "PERMANENTLY delete every message matching a query in an explicit mailbox. On Gmail this only works inside Trash or Spam (use empty_trash / empty_spam, or bulk_trash then empty_trash). Irreversible; requires confirm:true (dryRun:true to preview).",
      inputSchema: bulkShape,
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkDelete(bulkOpts(a));
    },
  );

  reg(
    server,
    "empty_spam",
    {
      title: "Empty Spam",
      description:
        "PERMANENTLY delete everything in the Spam/Junk mailbox (optionally narrowed by query). Irreversible; requires confirm:true. Use dryRun:true to see the count first.",
      inputSchema: bulkShape,
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkEmpty("junk", bulkOpts(a));
    },
  );

  reg(
    server,
    "empty_trash",
    {
      title: "Empty Trash",
      description:
        "PERMANENTLY delete everything in the Trash mailbox (optionally narrowed by query). Irreversible; requires confirm:true. Use dryRun:true to see the count first.",
      inputSchema: bulkShape,
      annotations: { destructiveHint: true },
    },
    async (a) => {
      const email = await writable(a.account);
      return (await host.getProvider(email)).bulkEmpty("trash", bulkOpts(a));
    },
  );

  // ---------- account management ----------
  // Registered only when the host owns a credential store. A deployment that
  // connects accounts through a provider's consent screen has no password to
  // take, and advertising a tool that asks for one would be a lie an agent acts
  // on. Scoped as a block rather than an early return so a tool appended below
  // is not silently gated on the same condition.
  const admin = host.accountAdmin;
  if (admin) {
    reg(
      server,
      "add_account",
      {
        title: "Add a mail account",
        description: `Add and verify a mail account, storing its App Password in the ${admin.credentialStoreName} (never in the registry or logs). provider: gmail (default) | icloud | fastmail | imap. For 'imap' pass imapHost + smtpHost (ports default to 993 / 465, or 587 with smtpStartTls). SECURITY: the App Password is an argument to this call, so it passes through the agent's context and the MCP client's logs. For the most private path, add accounts in the app's GUI instead; there the password goes straight to the local engine and the model never sees it.`,
        inputSchema: {
          email: z.string().describe("The account's email address."),
          appPassword: z
            .string()
            .describe(`App Password / IMAP password. Stored only in the ${admin.credentialStoreName}.`),
          provider: z
            .enum(["gmail", "icloud", "fastmail", "imap"])
            .optional()
            .describe("Mail provider (default gmail). Presets cover gmail/icloud/fastmail; 'imap' needs custom hosts."),
          imapHost: z.string().optional().describe("IMAP host (required for provider 'imap', e.g. imap.host.tld)."),
          imapPort: z.number().int().optional().describe("IMAP port (default 993)."),
          smtpHost: z.string().optional().describe("SMTP host (required for provider 'imap', e.g. smtp.host.tld)."),
          smtpPort: z.number().int().optional().describe("SMTP port (default 465, or 587 with smtpStartTls)."),
          smtpStartTls: z.boolean().optional().describe("Use STARTTLS on 587 instead of implicit TLS on 465."),
          displayName: z.string().optional(),
          makeDefault: z.boolean().optional().describe("Make this the default account."),
          readOnly: z.boolean().optional().describe("Refuse all writes for this account."),
        },
        annotations: { openWorldHint: true },
      },
      async (a) => {
        const provider = (a.provider ?? "gmail") as ProviderId;
        let connection: ConnectionConfig | undefined;
        if (provider === "imap") {
          if (!a.imapHost || !a.smtpHost) {
            throw new Error("provider 'imap' requires imapHost and smtpHost.");
          }
          const startTls = a.smtpStartTls === true;
          connection = {
            imapHost: a.imapHost,
            imapPort: a.imapPort ?? 993,
            smtpHost: a.smtpHost,
            smtpPort: a.smtpPort ?? (startTls ? 587 : 465),
            smtpSecure: !startTls,
          };
        }
        return admin.addAccount({
          email: a.email,
          appPassword: a.appPassword,
          provider,
          connection,
          displayName: a.displayName,
          default: a.makeDefault === true,
          readOnly: a.readOnly === true,
        });
      },
    );
  }
}
