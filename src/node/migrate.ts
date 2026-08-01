/**
 * migrate.ts - carry accounts and credentials across a rename.
 *
 * The 2026-08-01 rename shipped with no migration path, on the reasoning that
 * the install base was small enough to just re-add accounts. That reasoning was
 * wrong in a way worth recording: the cost of a rename is not paid by the
 * install base in aggregate, it is paid by each user individually, at the moment
 * they open a working app and find it empty. Nothing tells them their accounts
 * are still on disk. It reads as data loss, which is the one impression a tool
 * holding mail credentials cannot afford to give.
 *
 * So state is carried forward instead, under four rules:
 *
 *   1. NON-DESTRUCTIVE. Secrets are copied, never moved; the old config
 *      directory and the old Keychain items are left exactly as they were. If
 *      this code is wrong, the original is still there to be wrong about.
 *   2. MERGE, NEVER OVERWRITE. An account already configured under the current
 *      name wins. Import only fills gaps.
 *   3. ONCE, THEN NEVER AGAIN. A marker file records the import, so an account
 *      the user later deletes stays deleted instead of resurrecting on the next
 *      launch.
 *   4. NEVER FATAL, AND NEVER HALF-MARKED. A locked Keychain must not stop the
 *      server from starting - and must not write the marker either, or the retry
 *      that would have fixed it never happens. The marker is written only when
 *      every credential came across.
 *
 * Rule 4 is why `skipped` exists and why it gates the marker. An import that
 * moves the registry but not the credentials leaves an account that is listed,
 * looks configured, and fails on first connect: strictly worse than the empty
 * state it replaced.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { LEGACY_IDENTITIES } from "./legacy-names.js";
import { OAUTH_SERVICE, SERVICE, oauthKey } from "./keychain.js";
import type { Account } from "./registry.js";

/** Bumped when the importer learns to carry something it previously did not. */
const MARKER_VERSION = 1;

const MARKER_FILE = "legacy-import.json";
const REGISTRY_FILE = "accounts.json";

/**
 * The credential store, behind an interface purely so the tests can run without
 * a real Keychain. A test that needs the user's login Keychain is a test nobody
 * runs in CI, which for a migration is the same as no test at all.
 */
export interface SecretStore {
  read(service: string, key: string): string | null;
  write(service: string, key: string, value: string): void;
}

export const nativeSecretStore: SecretStore = {
  read(service, key) {
    try {
      return new Entry(service, key).getPassword();
    } catch {
      // Missing entries return null on macOS and throw on some other backends.
      return null;
    }
  },
  write(service, key, value) {
    new Entry(service, key).setPassword(value);
  },
};

export type ImportOutcome =
  /** A marker from a previous run is present; nothing was looked at. */
  | "already-imported"
  /** No previous identity had a registry with accounts in it. */
  | "nothing-to-import"
  /** Every legacy account was already configured here. */
  | "already-configured"
  /**
   * A previous install was found but nothing came across, because every
   * candidate account's credential was unreadable. Distinct from
   * "nothing-to-import" (there was nothing) and from "already-configured"
   * (there was, and you already have it) — those are fine and this is not.
   */
  | "blocked"
  /** At least one account was carried over. */
  | "imported";

export interface LegacyImportReport {
  outcome: ImportOutcome;
  /** Which past identity the state came from, when one was found. */
  from?: string;
  /** Emails whose registry entry AND credential both came across. */
  imported: string[];
  /** Emails already present under the current name, left untouched. */
  kept: string[];
  /**
   * Emails found in a legacy registry whose credential could not be read. These
   * block the marker, so the next launch tries again.
   */
  skipped: { email: string; reason: string }[];
  /** True when the marker was written, i.e. this will not run again. */
  sealed: boolean;
}

export interface ImportOptions {
  /** Override the home directory. Tests point this at a scratch dir. */
  home?: string;
  store?: SecretStore;
  /** Ignore an existing marker and re-run. Backs `import-legacy --force`. */
  force?: boolean;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readRegistry(dir: string): Account[] {
  const parsed = readJson<unknown>(join(dir, REGISTRY_FILE));
  return Array.isArray(parsed) ? (parsed as Account[]) : [];
}

/**
 * Copy one account's credential from a legacy service to the current one.
 * Returns null on success, or the reason it could not be carried.
 *
 * An account authenticates with EITHER an App Password OR OAuth, never both, so
 * `auth` on the registry entry decides which pair of keys to look for. The
 * client secret is optional: Google issues one for desktop clients and
 * Microsoft does not.
 */
function copyCredential(
  account: Account,
  legacyName: string,
  store: SecretStore,
): string | null {
  const email = account.email.toLowerCase();

  if (account.auth) {
    const issuer = account.auth.issuer;
    const refreshKey = oauthKey("refresh-token", issuer, email);
    const refresh = store.read(`${legacyName}-oauth`, refreshKey);
    if (!refresh) return "no refresh token stored under the previous name";

    // Only write when the current store has nothing: rule 2 applies to secrets
    // as much as to registry rows.
    if (!store.read(OAUTH_SERVICE, refreshKey)) {
      store.write(OAUTH_SERVICE, refreshKey, refresh);
    }

    const secretKey = oauthKey("client-secret", issuer, email);
    const clientSecret = store.read(`${legacyName}-oauth`, secretKey);
    if (clientSecret && !store.read(OAUTH_SERVICE, secretKey)) {
      store.write(OAUTH_SERVICE, secretKey, clientSecret);
    }
    return null;
  }

  const password = store.read(legacyName, email);
  if (!password) return "no App Password stored under the previous name";
  if (!store.read(SERVICE, email)) store.write(SERVICE, email, password);
  return null;
}

/**
 * Import accounts and credentials from the most recent previous identity that
 * has any. Safe to call unconditionally on every start: the common path is one
 * `existsSync` on the marker.
 */
export function importLegacyState(options: ImportOptions = {}): LegacyImportReport {
  const home = options.home ?? homedir();
  const store = options.store ?? nativeSecretStore;
  const currentDir = join(home, `.${SERVICE}`);
  const markerPath = join(currentDir, MARKER_FILE);

  const report: LegacyImportReport = {
    outcome: "nothing-to-import",
    imported: [],
    kept: [],
    skipped: [],
    sealed: false,
  };

  if (!options.force && existsSync(markerPath)) {
    report.outcome = "already-imported";
    return report;
  }

  const current = readRegistry(currentDir);
  const have = new Set(current.map((a) => a.email.toLowerCase()));

  // Newest legacy identity with accounts wins. A machine that has been through
  // both renames must not be handed its oldest registry.
  const source = LEGACY_IDENTITIES.map((identity) => ({
    identity,
    accounts: readRegistry(join(home, `.${identity.name}`)),
  })).find((candidate) => candidate.accounts.length > 0);

  if (!source) {
    // Nothing has ever been stored under a previous name, and never will be.
    // Seal so this is one `existsSync` forever after.
    seal(currentDir, markerPath, report);
    return report;
  }

  report.from = source.identity.name;
  const merged = [...current];

  for (const account of source.accounts) {
    const email = account.email.toLowerCase();
    if (have.has(email)) {
      report.kept.push(account.email);
      continue;
    }
    const failure = copyCredential(account, source.identity.name, store);
    if (failure) {
      report.skipped.push({ email: account.email, reason: failure });
      continue;
    }
    // A second registry cannot install a second default. Whatever is already
    // configured here keeps that flag.
    merged.push(merged.some((a) => a.default) ? { ...account, default: false } : account);
    report.imported.push(account.email);
  }

  if (report.imported.length > 0) {
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(
      join(currentDir, REGISTRY_FILE),
      JSON.stringify(merged, null, 2) + "\n",
      "utf8",
    );
  }

  report.outcome =
    report.imported.length > 0
      ? "imported"
      : report.kept.length > 0
        ? "already-configured"
        : "blocked";

  // Rule 4: a partial import stays unsealed so the next start retries the
  // accounts whose credentials were unreadable this time.
  if (report.skipped.length === 0) seal(currentDir, markerPath, report);
  return report;
}

function seal(dir: string, markerPath: string, report: LegacyImportReport): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          version: MARKER_VERSION,
          importedAt: new Date().toISOString(),
          from: report.from ?? null,
          imported: report.imported,
          outcome: report.outcome,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    report.sealed = true;
  } catch {
    // An unwritable config dir is a bigger problem than this, and the caller is
    // about to hit it. Do not make it fatal here.
  }
}

/** Human-readable summary for the CLI and the startup notice. */
export function describeImport(report: LegacyImportReport): string {
  const lines: string[] = [];
  if (report.imported.length > 0) {
    lines.push(
      `Carried ${report.imported.length} account(s) over from ${report.from}: ` +
        report.imported.join(", "),
    );
    lines.push(
      `Your previous data is untouched at ~/.${report.from}/ and in the ` +
        `"${report.from}" Keychain service. Remove it by hand once you are satisfied.`,
    );
  }
  for (const s of report.skipped) {
    lines.push(`Could not carry ${s.email}: ${s.reason}. Re-add it, or retry after unlocking the Keychain.`);
  }
  return lines.join("\n");
}

/**
 * Startup hook. Wrapped so no failure here can stop the server, and writing to
 * STDERR because in stdio mode stdout carries the MCP protocol and a stray line
 * on it corrupts the session.
 */
export function importLegacyStateOnStartup(): void {
  try {
    const report = importLegacyState();
    if (report.outcome === "imported" || report.skipped.length > 0) {
      const text = describeImport(report);
      if (text) process.stderr.write(text + "\n");
    }
  } catch (e) {
    process.stderr.write(
      `Legacy import skipped: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}
