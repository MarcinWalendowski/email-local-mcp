// The local host: how `anymail-core`'s tool layer reaches this machine.
//
// Four functions and a credential store, wired to the pieces that were already
// here — the JSON registry, the OS keyring, the connection-pooled IMAP/SMTP
// providers. Nothing new happens in this file; it exists so that the tool layer
// no longer imports `node:fs` transitively, which is the whole of SPEC-287
// phase 1.

import type { MailHost } from "../core/index.js";
import { addAccount, listPublic } from "./accounts.js";
import { credentialStoreName } from "./keychain.js";
import { getProvider } from "./providers/index.js";
import { assertWritable, resolveEmail } from "./registry.js";

export const nodeHost: MailHost = {
  listAccounts: async () => listPublic(),
  resolveEmail: async (account) => resolveEmail(account),
  assertWritable: async (email) => assertWritable(email),
  getProvider: async (email) => getProvider(email),
  accountAdmin: {
    // Resolved once, at load: it reads `process.platform`, which cannot change
    // under a running process. Tool descriptions are built once too.
    credentialStoreName: credentialStoreName(),
    addAccount: (input) => addAccount(input),
  },
};
