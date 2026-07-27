/**
 * The portable half of the MCP server instructions — everything that describes
 * the TOOLS rather than the deployment.
 *
 * A host prepends its own one-line overview (what it connects to and how) and
 * joins with a single space. Splitting it this way is not tidiness: these
 * sentences teach the agent the id model, the capability caveats and the bulk
 * continuation protocol, and a hosted deployment that re-worded any of them
 * would be a second product wearing the same tool names.
 */
export const TOOL_INSTRUCTIONS: readonly string[] = [
  "Every tool takes an optional `account` (email address); omit it to use the default account. list_accounts shows each account's provider.",
  "Message ids (`id`) and thread ids (`threadId`) are opaque strings returned by search_messages / get_message — pass them back verbatim, never construct them. `id` is not `messageId`, which is the RFC822 Message-ID header.",
  "Accounts differ in three INDEPENDENT ways, reported per account by list_accounts as `capabilities` — read those, never infer them from the provider name: `labels` (a message carries many; false = one folder per message, so use move/archive instead of modify_labels), `threads` (false = get_thread cannot resolve one, fall back to search_messages), `nativeSearch` (true = query is the provider's own syntax, e.g. Gmail 'from:alice newer_than:7d' plus 'in:anywhere' to reach Trash/Spam; false = a limited server-side text match, so pass plain text).",
  "Use trash_message for a reversible delete; delete_message is permanent and needs confirm:true.",
  "For whole-sets of mail, prefer the query-first bulk tools (mark_all_read, bulk_modify_labels, bulk_move, bulk_trash, bulk_delete, empty_spam, empty_trash) instead of looping single-message tools. Pass {query?, mailbox?}; call with dryRun:true first to see the matched count + sample, then confirm:true to run (required for destructive or >100-message batches). Target Spam/Trash with the mailbox param (e.g. '[Gmail]/Spam').",
  "Bulk trash/move/delete/empty act on up to `max` (default 2000) messages per call to stay under the tool timeout: if the result has done:false, re-run the exact same call (keep confirm:true) until done:true — `remaining` estimates what's left, and `failed[]` lists any per-message errors.",
];

/** Build the full instructions string from a host overview + the tool half. */
export function buildInstructions(overview: string): string {
  return [overview, ...TOOL_INSTRUCTIONS].join(" ");
}
