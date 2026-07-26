import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectionConfig, ProviderId } from "../core/index.js";

// Non-secret account metadata. The App Password itself lives in the macOS
// Keychain (see keychain.ts), never in this file.
export const CONFIG_DIR = join(homedir(), ".anymail-mcp");
export const REGISTRY_PATH = join(CONFIG_DIR, "accounts.json");
export const DOWNLOADS_DIR = join(CONFIG_DIR, "downloads");

export interface Account {
  email: string;
  displayName?: string;
  /** When true, this account is used when a tool omits `account`. */
  default?: boolean;
  /** When true, every write/destructive operation is refused for this account. */
  readOnly?: boolean;
  /** Mail provider. Defaults to "gmail" when omitted (back-compat with older registries). */
  provider?: ProviderId;
  /** Custom IMAP/SMTP endpoints — only for provider "imap"; presets cover the rest. */
  connection?: ConnectionConfig;
}

export function loadAccounts(): Account[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as Account[]) : [];
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: Account[]): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(accounts, null, 2) + "\n", "utf8");
}

function find(accounts: Account[], email: string): Account | undefined {
  const needle = email.toLowerCase();
  return accounts.find((a) => a.email.toLowerCase() === needle);
}

export function getAccount(email: string): Account {
  const account = find(loadAccounts(), email);
  if (!account) {
    throw new Error(`Account not configured: ${email}. Run: anymail-mcp add ${email}`);
  }
  return account;
}

/**
 * Resolve a requested account email to a configured one. When `email` is
 * omitted, fall back to the account flagged `default`, else the first account.
 */
export function resolveEmail(email?: string): string {
  const accounts = loadAccounts();
  if (email) return getAccount(email).email;
  const fallback = accounts.find((a) => a.default) ?? accounts[0];
  if (!fallback) {
    throw new Error("No accounts configured. Run: anymail-mcp add <email>");
  }
  return fallback.email;
}

/** Throw if the account is read-only. Call at the top of every write op. */
export function assertWritable(email: string): void {
  if (getAccount(email).readOnly) {
    throw new Error(`Account ${email} is configured read-only; write operations are refused.`);
  }
}

export function upsertAccount(account: Account): Account[] {
  const accounts = loadAccounts().filter(
    (a) => a.email.toLowerCase() !== account.email.toLowerCase(),
  );
  // Only one default at a time.
  if (account.default) accounts.forEach((a) => (a.default = false));
  accounts.push(account);
  saveAccounts(accounts);
  return accounts;
}

export function removeAccount(email: string): Account[] {
  const accounts = loadAccounts().filter(
    (a) => a.email.toLowerCase() !== email.toLowerCase(),
  );
  saveAccounts(accounts);
  return accounts;
}
