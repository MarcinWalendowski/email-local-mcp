/**
 * composio.test.ts — the Composio route, and the four ways it could quietly lie.
 *
 * Every fixture in this file was captured from the live v3 API, not written from
 * the documentation, because three of the four defects below are invisible in
 * the docs and only appear in a real response:
 *
 *   1. A FAILED OPERATION RETURNS HTTP 200. `{successful:false}` arrives with a
 *      200 status, so a client that trusts `res.ok` reports a failed delete as a
 *      successful one. Verified against a bad `message_id`.
 *   2. `error` IS A JSON-ENCODED STRING, not an object, wrapping Google's own
 *      envelope. `error.message` misses it, and passing the raw string through
 *      puts a ten-line blob where a sentence belongs.
 *   3. GMAIL'S `messageId` IS NOT THE RFC822 Message-ID. Composio uses the same
 *      word for the Gmail hex id, which is exactly the `id` vs `messageId`
 *      confusion the MailProvider interface exists to prevent. Reading it
 *      naively makes `messageId` a silent duplicate of `id`.
 *   4. `GMAIL_REMOVE_LABEL` DELETES THE LABEL FROM THE ACCOUNT. It takes no
 *      message id at all — "Permanently deletes a specific, existing
 *      user-created gmail label by its id". Reaching for it to unlabel one
 *      message would destroy that label on every message carrying it. There is a
 *      grep test below, because this one cannot be caught by behaviour: the
 *      damage happens on someone's real mailbox the first time it runs.
 *
 * No test here touches the network. `fetch` is stubbed throughout; a test that
 * silently reached the real API would be both slow and non-deterministic, and
 * would spend the user's Composio quota.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execute, listConnections, ComposioError } from "./client.js";
import { ComposioGmailProvider, toSummary } from "../providers/composio-gmail.js";
import { GMAIL_CAPABILITIES } from "../../core/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Stub `fetch`, returning `body` with `status`, and record what was requested. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  test.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

/**
 * The key is INJECTED. There is no env var and no credential-store lookup, and
 * `NEGATIVE: the API key is never read from the environment` below is what keeps
 * it that way.
 */
const CFG = { apiKey: "test-key" };

/* ── the client ───────────────────────────────────────────────────────────── */

test("only ACTIVE connections are returned, whatever the server sends", async () => {
  // A connected-account row is an ATTEMPT, not access: Composio writes it when a
  // connect link is minted, so an abandoned OAuth flow persists as a real-looking
  // row forever. Here the server "forgets" the status filter — the failure mode
  // that matters, because it fails OPEN and looks exactly like a longer list of
  // working connections.
  stubFetch({
    items: [
      { id: "ca_live", user_id: "u1", status: "ACTIVE", toolkit: { slug: "gmail" } },
      { id: "ca_abandoned", user_id: "u1", status: "EXPIRED", toolkit: { slug: "gmail" } },
      { id: "ca_failed", user_id: "u1", status: "FAILED", toolkit: { slug: "gmail" } },
      { id: "ca_pending", user_id: "u1", status: "INITIALIZING", toolkit: { slug: "gmail" } },
    ],
  });

  const conns = await listConnections(CFG, "gmail");
  assert.deepEqual(
    conns.map((c) => c.id),
    ["ca_live"],
    "the client-side check must decide, not the query string",
  );
});

test("the user filter is user_ids, plural", async () => {
  // The singular `user_id` is not a narrowing filter on this endpoint — it
  // returns other users' rows. Anything built on the singular form leaks
  // connections across users, so the parameter name is the assertion.
  const calls = stubFetch({ items: [] });
  await listConnections(CFG, "gmail", "u_abc");

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("user_ids"), "u_abc");
  assert.equal(url.searchParams.get("user_id"), null, "the singular form must never be sent");
});

test("a failed operation is not reported as success, despite HTTP 200", async () => {
  // Captured verbatim from the live API: a bad message_id.
  stubFetch(
    JSON.parse(readFileSync(join(HERE, "__fixtures__/execute-error.json"), "utf8")),
    200,
  );
  await assert.rejects(
    () =>
      execute(CFG, "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        connectedAccountId: "ca_1",
        userId: "u1",
      }),
    (e: Error) => {
      assert.ok(e instanceof ComposioError);
      // The sentence, not the JSON blob it was buried in.
      assert.match(e.message, /Invalid id value/);
      assert.ok(!e.message.includes("\n  "), "a pretty-printed blob leaked into the message");
      return true;
    },
  );
});

test("execute sends both ids, because the API rejects the connection id alone", async () => {
  // Omitting user_id returns HTTP 400 ActionExecute_ConnectedAccountEntityIdRequired.
  const calls = stubFetch({ data: { ok: true }, successful: true });
  await execute(CFG, "GMAIL_GET_PROFILE", { connectedAccountId: "ca_1", userId: "u_1" });

  const sent = JSON.parse(String(calls[0].init?.body));
  assert.equal(sent.connected_account_id, "ca_1");
  assert.equal(sent.user_id, "u_1");
});

/* ── the message mapping ──────────────────────────────────────────────────── */

test("a real Composio message maps without inventing anything", () => {
  const raw = JSON.parse(readFileSync(join(HERE, "__fixtures__/fetch-emails.json"), "utf8"));
  const msg = toSummary(raw.data.messages[0]);

  // The handle is Gmail's id...
  assert.equal(msg.id, "19fbe4a7f4866f58");
  // ...and `messageId` is the RFC822 header, NOT a copy of it.
  assert.equal(msg.messageId, "<test-rfc822-id@mail.example.com>");
  assert.notEqual(msg.messageId, msg.id, "messageId must not be a duplicate of id");

  assert.equal(msg.subject, "Your July Flow State recap");
  assert.equal(msg.from, "Wispr Flow <hello@mail.wispr.ai>");
  assert.equal(msg.unread, true);
  assert.deepEqual(msg.labels, ["UNREAD", "CATEGORY_UPDATES", "INBOX"]);

  // Absent beats plausible. An HTTP API has no IMAP UID, and Composio returns no
  // size — a 0 in either field is a number a model would reason about.
  assert.equal(msg.uid, null, "uid must be null, never 0");
  assert.equal(msg.size, null, "size must be null, never 0");
});

test("flags carry only what Gmail labels actually mean", () => {
  const read = toSummary({ messageId: "a", labelIds: ["INBOX", "STARRED"] });
  assert.deepEqual(read.flags, ["\\Seen", "\\Flagged"]);
  assert.equal(read.unread, false);

  const unread = toSummary({ messageId: "b", labelIds: ["UNREAD"] });
  assert.deepEqual(unread.flags, [], "no \\Seen when UNREAD is present");
  assert.equal(unread.unread, true);
});

/* ── negative controls ────────────────────────────────────────────────────── */

test("NEGATIVE: the label-deleting tool is never used to unlabel a message", () => {
  // This cannot be tested by behaviour without destroying a real label, so the
  // source is the subject. GMAIL_REMOVE_LABEL takes only a label_id and
  // permanently deletes the label for the whole account; removing a label from
  // ONE message is GMAIL_ADD_LABEL_TO_EMAIL with remove_label_ids.
  const src = readFileSync(join(HERE, "../providers/composio-gmail.ts"), "utf8");
  const calls = src.match(/this\.run\(\s*"(GMAIL_[A-Z_]+)"/g) ?? [];
  assert.ok(calls.length > 0, "the grep must actually match the call sites");
  assert.ok(
    !calls.some((c) => c.includes("GMAIL_REMOVE_LABEL")),
    "GMAIL_REMOVE_LABEL deletes the label from the account; it must never be a call site here",
  );
  assert.ok(
    src.includes("remove_label_ids"),
    "removing a label from a message must go through remove_label_ids",
  );
});

test("NEGATIVE: send refuses what Composio cannot do, instead of doing less", async () => {
  // Both of these would otherwise "succeed": the mail would send, just without
  // the attachment the user named, or without threading. A send that silently
  // drops part of the request is worse than one that fails, because the user
  // believes it happened.
  const p = new ComposioGmailProvider(CFG, "you@example.com", "ca_1", "u_1");
  const base = { to: "someone@example.com", subject: "s", text: "t" };

  await assert.rejects(
    () => p.send({ ...base, attachments: [{ path: "/tmp/x.pdf" }] }),
    /attachments is not supported/i,
  );
  await assert.rejects(
    () => p.send({ ...base, inReplyTo: "<abc@example.com>" }),
    /inReplyTo\) is not supported/i,
  );
  // Drafts go through the same gate — a draft that quietly lost its attachment
  // is a mail the user will send believing it is complete.
  await assert.rejects(
    () => p.createDraft({ ...base, attachments: [{ path: "/tmp/x.pdf" }] }),
    /attachments is not supported/i,
  );
});

test("NEGATIVE: an irreversible bulk delete must name where it runs", async () => {
  const p = new ComposioGmailProvider(CFG, "you@example.com", "ca_1", "u_1");
  await assert.rejects(() => p.bulkDelete({ confirm: true }), /requires an explicit mailbox/i);
});

test("NEGATIVE: capabilities are the shared answer, not a second copy", () => {
  // Both hosts serve Gmail, and both must describe it identically — two copies
  // of "labels/threads/search" is how `list_accounts` starts advertising a
  // mailbox the live provider cannot honour. Identity, not deep equality: a
  // structurally equal literal declared here would satisfy `deepEqual` while
  // being exactly the duplicate this asserts against.
  const p = new ComposioGmailProvider(CFG, "you@example.com", "ca_1", "u_1");
  assert.equal(
    p.capabilities,
    GMAIL_CAPABILITIES,
    "must reference core's constant, not restate it",
  );
});

test("NEGATIVE: the API key is never read from the environment", async () => {
  // The whole reason this module moved out of the local host: it used to reach
  // into the OS credential store for its key, which made it silently node-only
  // and unusable in the Worker it is actually for. An env var would be the same
  // mistake wearing a different hat, so the environment is poisoned here and the
  // injected value has to win.
  process.env.COMPOSIO_API_KEY = "environment-key";
  const calls = stubFetch({ items: [] });
  await listConnections({ apiKey: "injected-key" }, "gmail");

  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "injected-key");
  delete process.env.COMPOSIO_API_KEY;

  // ...and with nothing injected it must refuse rather than fall back.
  await assert.rejects(() => listConnections({ apiKey: "" }, "gmail"), /No Composio API key/);
});

test("NEGATIVE: an attachment savePath is refused, not silently ignored", async () => {
  // `savePath` is in the shared interface because the local host can honour it.
  // This host has no disk. Accepting the argument and returning success would
  // tell a caller their 40 MB attachment is on disk at a path that does not
  // exist — the one failure direction that loses the data.
  stubFetch({
    data: {
      messages: [
        {
          messageId: "m1",
          attachmentList: [{ attachmentId: "att_1", filename: "x.pdf", mimeType: "application/pdf" }],
        },
      ],
    },
    successful: true,
  });
  const p = new ComposioGmailProvider(CFG, "you@example.com", "ca_1", "u_1");
  await assert.rejects(
    () => p.getAttachment("m1", 0, "/tmp/x.pdf"),
    /no local filesystem/i,
  );
});
