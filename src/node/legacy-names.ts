/**
 * legacy-names.ts - every identity this project has shipped under.
 *
 * The previous names live here and nowhere else in `src/`, so that the
 * exemption in `tools/name-check` covers a table of data rather than a whole
 * implementation module. The fence below is three lines wide and everything
 * else in this file is still checked; allowlisting migrate.ts instead would
 * have switched the guard off for the file most likely to be edited from memory
 * later.
 *
 * Order is newest-first. The importer takes the first entry that actually has
 * accounts, so a machine that has been through both renames gets its most
 * recent state rather than its oldest.
 *
 * Adding a future rename is one line here. That is the point: the third rename
 * should cost a string, not a rediscovery of which four places store state.
 */

/**
 * A single past identity. Each one determines a config directory
 * (`~/.<name>/`), a Keychain service (`<name>`) and an OAuth Keychain service
 * (`<name>-oauth`) - the four places account state has ever lived.
 */
export interface LegacyIdentity {
  /** The bare app name, which is also the config-dir and Keychain-service stem. */
  name: string;
  /** When this name was retired, for the report and for support questions. */
  retired: string;
}

// name-check: legacy-ok — the past names, which is the one thing this file is for.
export const LEGACY_IDENTITIES: readonly LegacyIdentity[] = [
  { name: "anymail-mcp", retired: "2026-08-01" },
  { name: "gmail-mcp", retired: "2026-07-14" },
];
// name-check: /legacy-ok
