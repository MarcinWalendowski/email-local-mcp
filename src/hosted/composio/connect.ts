// Turning a Composio connection into an account this app can use.
//
// The one hard problem here is naming. Composio does not know whose mailbox a
// connection is: `user_id` is whatever string the *integrating application*
// chose — in practice an internal id or a phone number — and there is no
// address field anywhere on the connected-account row. So the address has to
// come from the provider, by asking Gmail itself.

import {
  execute,
  listConnections,
  type ComposioConfig,
  type ComposioConnection,
} from "./client.js";

export interface ResolvedConnection extends ComposioConnection {
  /**
   * The mailbox this connection actually controls, or null when Gmail would not
   * say.
   *
   * Null is a real answer and is kept, not filtered out: a connection we cannot
   * name is still a connection the user owns, and hiding it would present a
   * shorter list as if it were complete. `connect` shows it with its id so the
   * user can still choose it deliberately.
   */
  email: string | null;
}

/**
 * Ask Gmail which mailbox a connection belongs to.
 *
 * Cached for the process lifetime **including the null**. Caching only the hits
 * means a connection that cannot be named is re-probed on every listing, which
 * is the slowest path being taken most often.
 */
const identityCache = new Map<string, string | null>();

export async function resolveAddress(
  cfg: ComposioConfig,
  conn: ComposioConnection,
): Promise<string | null> {
  const cached = identityCache.get(conn.id);
  if (cached !== undefined) return cached;

  let email: string | null = null;
  try {
    const data = await execute<{ response_data?: { emailAddress?: string } }>(
      cfg,
      "GMAIL_GET_PROFILE",
      { connectedAccountId: conn.id, userId: conn.userId },
    );
    email = data.response_data?.emailAddress ?? null;
  } catch {
    // A connection can be ACTIVE and still fail to answer — revoked at Google's
    // end, scope changed, transient outage. That is not fatal to *listing*, so
    // it resolves to null and the caller decides.
    email = null;
  }
  identityCache.set(conn.id, email);
  return email;
}

/**
 * Every ACTIVE Gmail connection, each with the address it controls.
 *
 * Probes run concurrently because this is the interactive path — `connect` with
 * no arguments — and a serial loop over a dozen connections is the difference
 * between a listing and a wait.
 */
export async function listResolved(
  cfg: ComposioConfig,
  userId?: string,
): Promise<ResolvedConnection[]> {
  const conns = await listConnections(cfg, "gmail", userId);
  return Promise.all(
    conns.map(async (c) => ({ ...c, email: await resolveAddress(cfg, c) })),
  );
}
