// A minimal Composio v3 client: list this user's connections, and execute one
// tool against one of them. Nothing else — this file is the whole surface the
// rest of the app is allowed to see of Composio.
//
// WHY COMPOSIO IS A SEPARATE ROUTE AND NOT JUST ANOTHER OAUTH ISSUER
//
// The design we wanted was: let Composio run the OAuth dance (they are already a
// verified Google client, which is the entire friction this mode exists to
// remove), then hand us the access token so the local IMAP/SMTP engine opens the
// mailbox exactly as it does for every other account. Mail would still never
// leave the machine.
//
// Composio does not permit that. Verified against the live API on an ACTIVE
// Gmail connection: `access_token`, `refresh_token`, `id_token` and
// `headers.Authorization` all come back as the literal four-character string
// "REDACTED". The connection genuinely holds `https://mail.google.com/`, so the
// capability is there; it is simply never handed out.
//
// So a Composio-backed account cannot be served locally. Its mail is fetched and
// sent by Composio's servers on our behalf. That is a real, user-visible
// difference from every other account this app serves, and the reason
// `list_accounts`, the README, SECURITY.md and the landing page all had to stop
// making one flat "nothing leaves your machine" claim and start answering per
// account.

const DEFAULT_BASE = "https://backend.composio.dev";

/** Composio's own name for a connection that is usable. Anything else is not. */
const ACTIVE = "ACTIVE";

export interface ComposioConnection {
  id: string;
  userId: string;
  status: string;
  toolkit: string;
}

/**
 * What the registry stores for a Composio-backed account.
 *
 * Both ids are required, and `userId` is not redundant: the execute endpoint
 * rejects a call carrying only `connectedAccountId` with
 * `ActionExecute_ConnectedAccountEntityIdRequired`. Storing one and hoping to
 * derive the other later does not work, so `connect` captures both up front.
 *
 * No secret lives here — the API key is per installation, in the OS credential
 * store — so this record is safe in plain `accounts.json` alongside the rest.
 */
export interface ComposioAuth {
  kind: "composio";
  connectedAccountId: string;
  userId: string;
}

export class ComposioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = "ComposioError";
  }
}

/**
 * Everything this client needs from its host, passed in rather than read.
 *
 * The API key is **injected, never looked up**. An earlier version of this file
 * read it from the OS credential store, which quietly made the whole module
 * node-only and unusable from the target it is actually for: a Worker has no
 * Keychain, no Secret Service, and no `process.env` of the kind a desktop app
 * has. A hosted host holds its key as a binding or a secret and hands it over.
 *
 * That is also the honest dependency direction. This module knows how to talk to
 * Composio; where a deployment keeps its credentials is the deployment's
 * business, and a shared module that reaches for one is a shared module with a
 * platform baked in.
 */
export interface ComposioConfig {
  apiKey: string;
  /** Override for tests or a proxy. Defaults to Composio's production API. */
  baseUrl?: string;
}

async function request(cfg: ComposioConfig, path: string, init?: RequestInit): Promise<unknown> {
  if (!cfg.apiKey) throw new ComposioError("No Composio API key was supplied.");
  const res = await fetch(`${cfg.baseUrl ?? DEFAULT_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": cfg.apiKey,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string; code?: string | number } }
    | null
    | unknown;
  if (!res.ok) {
    const err = (body as { error?: { message?: string; code?: string | number } })?.error;
    throw new ComposioError(
      err?.message || `Composio ${path} failed with HTTP ${res.status}`,
      res.status,
      err?.code,
    );
  }
  return body;
}

/**
 * Every ACTIVE connection for a toolkit.
 *
 * Two rules here were each learned the hard way in another codebase against this
 * same API, and both are load-bearing:
 *
 *  1. **`user_ids`, plural.** The singular `user_id` parameter is not a filter
 *     that narrows to one user — passing it returns other users' rows. Anything
 *     built on the singular form leaks connections across users.
 *
 *  2. **A connected-account row is an attempt, not access.** Composio writes the
 *     row when a connect link is *minted*, before the user has approved
 *     anything, so an abandoned OAuth flow persists forever as a real-looking
 *     row. Only `ACTIVE` means a usable mailbox.
 *
 * The status filter goes in the query string *and* is re-checked here. That is
 * not belt-and-braces for its own sake: a server-side filter that stops being
 * honoured fails **open**, and the failure looks exactly like success — a longer
 * list of plausible connections. The client-side check is the one that cannot
 * silently stop working, so it is the one that decides.
 */
export async function listConnections(
  cfg: ComposioConfig,
  toolkit = "gmail",
  userId?: string,
): Promise<ComposioConnection[]> {
  const params = new URLSearchParams({
    toolkit_slugs: toolkit,
    statuses: ACTIVE,
    limit: "100",
  });
  if (userId) params.append("user_ids", userId);

  const body = (await request(cfg, `/api/v3/connected_accounts?${params}`)) as {
    items?: unknown[];
    data?: unknown[];
  };
  const rows = (body?.items ?? body?.data ?? []) as Record<string, unknown>[];

  return rows
    .map((r) => ({
      id: String(r.id ?? ""),
      userId: String(r.user_id ?? ""),
      status: String(r.status ?? ""),
      toolkit: String((r.toolkit as { slug?: string })?.slug ?? toolkit),
    }))
    .filter((c) => c.id && c.status === ACTIVE);
}

/**
 * Run one Composio tool against one connection.
 *
 * `user_id` is not optional despite `connected_account_id` already identifying
 * the connection uniquely: the API rejects the call with
 * `ActionExecute_ConnectedAccountEntityIdRequired` (HTTP 400) when it is
 * missing. Hence `ComposioAuth` carries both, and the registry stores both.
 *
 * The envelope is `{ data, successful, error, log_id }`, and `successful:false`
 * arrives with **HTTP 200** — so checking the status code alone reports a failed
 * mail operation as a success. The `successful` flag is the one that decides.
 * Verified: a bad `message_id` returns HTTP 200 / `successful:false`.
 */
export async function execute<T = Record<string, unknown>>(
  cfg: ComposioConfig,
  tool: string,
  opts: { connectedAccountId: string; userId: string; arguments?: Record<string, unknown> },
): Promise<T> {
  const body = (await request(cfg, `/api/v3/tools/execute/${tool}`, {
    method: "POST",
    body: JSON.stringify({
      connected_account_id: opts.connectedAccountId,
      user_id: opts.userId,
      arguments: opts.arguments ?? {},
    }),
  })) as { data?: T; successful?: boolean; error?: unknown };

  if (body?.successful === false) {
    throw new ComposioError(`Composio ${tool}: ${describeError(body.error) ?? "failed"}`);
  }
  return (body?.data ?? {}) as T;
}

/**
 * Pull a human-readable sentence out of the `error` field.
 *
 * It arrives as a **JSON-encoded string** wrapping Google's own error envelope,
 * not as an object — so the obvious `error.message` misses, and passing the
 * string straight through puts a pretty-printed JSON blob in front of the user
 * where a sentence belongs ("Invalid id value" is in there, ten lines down).
 * Parse if it parses, fall back to the raw text if it does not.
 */
function describeError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "object") {
    return (error as { message?: string }).message ?? JSON.stringify(error);
  }
  if (typeof error !== "string") return String(error);
  try {
    const parsed = JSON.parse(error) as { error?: { message?: string }; message?: string };
    return parsed?.error?.message ?? parsed?.message ?? error;
  } catch {
    return error;
  }
}
