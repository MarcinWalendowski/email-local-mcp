import { Entry } from "@napi-rs/keyring";

// @napi-rs/keyring ships prebuilt native binaries (no node-gyp) and is backed by
// the platform's native store: the macOS Security framework (login Keychain) on
// darwin, the Windows Credential Manager on win32, and the Secret Service
// (gnome-keyring / KWallet) on Linux.
const SERVICE = "anymail-mcp";

// Cache passwords in memory for the process lifetime. Reading the store on
// every IMAP/SMTP (re)connect would trigger a "node wants to use your keychain"
// prompt each time on macOS; reading once keeps it quiet.
const cache = new Map<string, string>();

/** Human name of the OS-native credential store, for user-facing messages. */
export function credentialStoreName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "Secret Service (gnome-keyring / KWallet)";
}

/**
 * Actionable guidance when the native store is unavailable. On Linux this is
 * the common failure (no Secret Service running), so we spell out the fix,
 * including a headless-server recipe. On mac/Windows the store is built in, so
 * we just name it and suggest it may be locked.
 */
function storeUnavailableHint(): string {
  if (process.platform === "linux") {
    return (
      "AnyMail MCP needs a running Secret Service (gnome-keyring or KWallet) with an unlocked " +
      "login keyring. On a headless machine, start one under a D-Bus session, e.g.: " +
      "dbus-run-session -- sh -c 'gnome-keyring-daemon --start --daemonize; anymail-mcp add <email>'."
    );
  }
  return `Make sure the ${credentialStoreName()} is available and unlocked, then retry.`;
}

function entry(email: string): Entry {
  return new Entry(SERVICE, email.toLowerCase());
}

export function setAppPassword(email: string, appPassword: string): void {
  try {
    entry(email).setPassword(appPassword);
  } catch (e) {
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not save the App Password for ${email} in the ${credentialStoreName()}: ${orig}. ${storeUnavailableHint()}`,
      { cause: e },
    );
  }
  cache.set(email.toLowerCase(), appPassword);
}

export function getAppPassword(email: string): string {
  const key = email.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  let pass: string | null;
  try {
    pass = entry(email).getPassword();
  } catch (e) {
    // A missing entry throws on some backends (Windows / Linux) but returns null
    // on macOS, so this path covers both "none stored" and "store unavailable".
    const orig = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not read the App Password for ${email} from the ${credentialStoreName()}. ` +
        `Either none is stored (run: anymail-mcp add ${email}) or the store is unavailable. ` +
        `${storeUnavailableHint()} (${orig})`,
      { cause: e },
    );
  }
  if (!pass) {
    throw new Error(
      `No App Password found in the ${credentialStoreName()} for ${email}. Run: anymail-mcp add ${email}`,
    );
  }
  cache.set(key, pass);
  return pass;
}

export function hasAppPassword(email: string): boolean {
  if (cache.has(email.toLowerCase())) return true;
  try {
    return Boolean(entry(email).getPassword());
  } catch {
    return false;
  }
}

export function deleteAppPassword(email: string): void {
  cache.delete(email.toLowerCase());
  try {
    entry(email).deletePassword();
  } catch {
    // Nothing stored — treat as already deleted.
  }
}
