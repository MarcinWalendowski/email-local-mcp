# email-local-mcp — Bulk / batch operations proposal

Suggestions for handling large-scale mailbox actions (e.g. "mark all 10k emails
as read", "empty Spam") in a single, cheap operation instead of one-message-at-a-time.

Grounded in the current code: `src/providers/gmail.ts`, `src/providers/imap.ts`,
`src/mcp/tools.ts`. Stack: `imapflow` + Gmail X-GM-* extensions.

> **Status: implemented** (shipped in v0.0.1-rc.1) — kept for design rationale. What
> actually shipped differs in a few places: the bulk engine (`runBulk`) lives on
> the base `ImapProvider` (so generic IMAP gets it too) and `resolveAnywhere` on
> `GmailProvider`; chunks are ≤500 UIDs compacted into `a:b` ranges; Gmail
> `bulk_delete` **refuses** any mailbox but Trash/Spam (no arbitrary-mailbox
> move→re-find→expunge); `mark_all_unread` / `bulk_star` / `bulk_unstar` were not
> built (use `bulk_modify_labels` / the single-message tools). The `delete()`
> false-success bug is fixed. See `CHANGELOG.md` for the shipped tool surface.
>
> **Naming:** the sketches below say `gmMsgId` / `gmMsgIds[]`. The shipped fields are
> **`id`** and **`threadId`** (renamed once the engine stopped being Gmail-only), and
> the bulk tools are query-first — they never took an id array. Read the code sketches
> for their shape, not their names.

---

## 1. Two problems observed

### 1a. Mutations can't touch Spam/Trash-resident messages
Every Gmail mutation (`markRead`, `star`, `archive`, `move`, `modifyLabels`,
`trash`) opens `this.searchScope(boxes)`:

```ts
// imap.ts
protected searchScope(boxes) { return boxes.all ?? boxes.inbox; }  // => [Gmail]/All Mail
```

then resolves the id **inside that single mailbox**:

```ts
// gmail.ts
private async resolveUid(client, gmMsgId) {
  const uids = await client.search({ emailId: gmMsgId }, { uid: true });
  ...
}
```

**Gmail's All Mail deliberately excludes `[Gmail]/Spam` and `[Gmail]/Bin`.** So a
message living in Spam/Trash is never found → `NotFoundError`. This is why
`trash_message` / `move_message` / `modify_labels` all failed on the 20 Spam
messages, even though `search_messages` found them (search accepts a `folder`
param and opens `[Gmail]/Spam` directly; the mutations have no such param).

**Proven, not inferred:** in the same session, `search {query:"in:spam"}` (which
runs X-GM-RAW inside the default All-Mail scope) returned **0**, while
`search {query:"…", folder:"[Gmail]/Spam"}` returned **20**. That gap is direct
evidence that X-GM-RAW SEARCH is constrained to the *selected* mailbox — which is
also why a true `in:anywhere` bulk op must iterate mailboxes (see §4).

**Bonus latent bug — `delete()` reports false success on a Spam message:**
`delete()` step 1 opens All Mail to move→Trash (uid `undefined`, silently skips
the move); step 2 opens Trash and searches there (also `undefined`, hits the
`// already gone` branch) and returns `{ deleted: true }`. Nothing was deleted,
but the caller is told it succeeded.

### 1b. No batch — every op is single-message
`resolveUid` even discards all-but-one match (`uids[uids.length - 1]`), and each
tool acts on exactly one id. "Mark 10k as read" = 10,000 tool calls / IMAP
round-trips. Infeasible.

---

## 2. Design shift

> Resolve **a UID set in a known mailbox**, then act on the whole set in **one**
> IMAP command — instead of resolving one X-GM-MSGID and acting on one message.

`imapflow`'s mutation methods already accept a UID **set / range**, so this is
nearly free:

```ts
// one STORE / MOVE for the whole set:
await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });                 // mark read
await client.messageFlagsAdd(uids, ['Ekorepetycje'], { uid: true, useLabels: true }); // add a label
await client.messageMove(uids, trash, { uid: true });                          // trash: MOVE to [Gmail]/Bin
await client.messageDelete(uids, { uid: true });                               // in Trash → permanent
```

> Trash via **`messageMove` → `[Gmail]/Bin`** (what the current `trash()` already
> does), *not* by adding a `\Trash` label — adding `\Trash` via X-GM-LABELS is an
> unreliable Gmail-IMAP path.

And for "the entire mailbox" you don't even enumerate ids — STORE the `1:*` UID
range on the open mailbox:

```ts
await withMailbox(client, 'INBOX', () =>
  client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true }));   // mark all inbox read, 1 command
```

This single change fixes **both** problems: batch tools take an explicit
`mailbox`, so acting on Spam/Trash is just `mailbox: '[Gmail]/Spam'`.

---

## 3. Proposed provider methods (`GmailProvider`)

```ts
// resolve every matching UID in a mailbox (no "keep last" truncation)
private async searchUids(client, query: string): Promise<number[]> {
  return (await client.search({ gmraw: query }, { uid: true })) || [];
}

// cross-folder fallback for single-id ops (fixes the Spam/Trash NotFound)
private async resolveAnywhere(client, boxes, gmMsgId) {
  for (const box of [boxes.all, boxes.junk, boxes.trash, boxes.inbox].filter(Boolean)) {
    const uid = await withMailbox(client, box, () => this.resolveUid(client, gmMsgId));
    if (uid !== undefined) return { box, uid };
  }
  return undefined;
}

// generic batch flag/label/move over a query, chunked
async bulkFlag(query, mailbox, { addFlags = [], removeFlags = [], useLabels = false }) {
  const client = await this.getClient();
  return withMailbox(client, mailbox, async () => {
    const uids = await this.searchUids(client, query);   // all matches, no limit
    for (const chunk of chunkOf(uids, 2000)) {           // command-length safety
      if (addFlags.length)    await client.messageFlagsAdd(chunk, addFlags, { uid: true, useLabels });
      if (removeFlags.length) await client.messageFlagsRemove(chunk, removeFlags, { uid: true, useLabels });
    }
    return { matched: uids.length, affected: uids.length, mailbox };
  });
}
```

Then `bulkTrash`, `bulkDelete`, `bulkMove`, `bulkModifyLabels`, `bulkArchive`
are thin wrappers over `searchUids` + a chunked `messageMove` / `messageDelete` /
`messageFlagsAdd(..., useLabels)`.

---

## 4. Proposed MCP tools (query-first)

| Tool | Params | Maps to |
|---|---|---|
| `mark_all_read` | `{ query?, mailbox?, dryRun? }` | STORE `+\Seen` on matched UID set (or `1:*` if no query) |
| `mark_all_unread` | `{ query?, mailbox?, dryRun? }` | STORE `-\Seen` |
| `bulk_star` / `bulk_unstar` | `{ query, mailbox? }` | STORE `±\Flagged` |
| `bulk_trash` | `{ query \| gmMsgIds[], mailbox?, dryRun? }` | `messageMove` set → Trash |
| `bulk_delete` | `{ query \| gmMsgIds[], mailbox?, confirm }` | move→Trash then `messageDelete` in Trash |
| `bulk_move` | `{ query, targetLabel, mailbox? }` | STORE `+label`, `-\Inbox` |
| `bulk_modify_labels` | `{ query, add[], remove[], mailbox? }` | STORE `±labels` (`useLabels`) |
| `empty_spam` | `{ confirm }` | select `[Gmail]/Spam`, `messageDelete('1:*')` |
| `empty_trash` | `{ confirm }` | select `[Gmail]/Bin`, `messageDelete('1:*')` |

Notes
- `mailbox` mirrors `search`'s existing `folder` param. Default `[Gmail]/All Mail`
  (current behavior); pass `[Gmail]/Spam` / `[Gmail]/Bin` to reach those.
- `query` uses the same X-GM-RAW syntax as `search`. Empty query + `mailbox` =
  "the whole mailbox" — this touches **everything**, including already-read and
  (in All Mail) Sent. For the literal "10k unread → read" ask, pass
  `query: "is:unread"` so it's cheaper and never touches Sent.
- IMAP SEARCH is per-mailbox, so a true `in:anywhere` bulk op iterates
  `[All Mail, Spam, Trash]` and sums the results (don't rely on one SELECT).

---

## 5. Safety rails (important for destructive batches)

- **`dryRun: true`** → return `{ matched: N, sample: [subjects…] }` and act on
  nothing. Let the caller see the blast radius first.
- **`confirm: true` required** for `bulk_delete`, `empty_spam`, `empty_trash`,
  and for any batch above a threshold (e.g. affected > 200, configurable).
- **Never silently cap.** Always return the real `matched` / `affected` counts;
  if you chunk or stop early, say so in the result.
- **Structured result** for partial failure: `{ query, mailbox, matched,
  succeeded, failed: [{ uid, error }] }`.
- Fix the false-success in `delete()`: if step 1 didn't find/move the id and
  step 2 finds nothing, return `{ deleted: false, reason: "not found" }`, not
  `{ deleted: true }`.

---

## 6. Performance notes

- 10k "mark read" → ~5 STORE commands at 2k UIDs/chunk (or one `1:*` STORE if
  it's the whole mailbox). vs. 10k round-trips today.
- Compact contiguous UIDs into ranges (`1:5000`) to shrink command lines further.
- Keep the existing single-message tools as batch-of-one wrappers for the common
  one-off case; the bulk tools are additive, not a breaking change.

---

## 7. Minimum viable slice (if you want the 80/20 first)

1. `resolveAnywhere` fallback in the six single-id mutations → unblocks
   Spam/Trash immediately (small, surgical).
2. `mark_all_read { query?, mailbox?, dryRun? }` + `empty_spam`/`empty_trash`
   → covers the "10k as read" and "clear Spam" asks.
3. `dryRun` + `confirm` gating on the destructive ones.

Everything else (full `bulk_*` matrix, cross-folder `in:anywhere`) can follow.

---

## 8. Large-batch timeout (resolved)

**Observed in real use:** trashing ~8,457 messages (top-20 senders) in one
`bulk_trash` call ran past the MCP client's tool timeout after moving ~8,257. The
engine did the safe thing — progress persisted per chunk and trashing is
idempotent, so re-running finished the last ~200 — but the *tool call itself
returned an error* instead of a partial result. For a big set that's a rough edge.

**Fix shipped (not async, not a cursor):** the removing ops (trash/move/delete/
empty) now act on at most **`max` messages per call (default 2000)** and return
`{ matched, affected, remaining, done }`. Because an acted message leaves the search
scope, **re-running the exact same call continues** where it left off; the agent
loops until `done:true`. Each call stays well under the timeout.

- **No cursor.** A UID high-water cursor was rejected: it would skip a failed
  message (advance past it) and could then report `done:true` with the failure
  silently dropped — violating the "partial failures reported, never a false
  success" guarantee. Re-running instead keeps failures in scope so they retry,
  and `failed[]` is always returned; `done:true` only means the whole matched set
  was covered this call.
- **Flag ops are not capped.** `mark_all_read` / `bulk_modify_labels` are cheap
  STOREs and *don't* self-narrow (the messages stay), so capping them would loop on
  the same first `max` forever. They run in one uncapped call. For `mark_all_read`
  over a huge inbox, pass `query:"is:unread"` so it only touches what's needed.
- **Not chosen:** an async job model (start → poll status). More moving parts and
  engine-side job state; the re-run-until-done loop delivers the same resumability
  for free given idempotent, self-narrowing removals.
