import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CONFIG_DIR } from "./registry.js";
import { logger } from "./logger.js";

/**
 * Local capability token + port for the always-on HTTP server. Stored in a
 * user-only (0600) file so the installer and the Swift app can read it without
 * a cross-app Keychain prompt. The token defends the loopback endpoint against
 * web pages (DNS-rebinding) and other users; the actual mail secrets stay in
 * the Keychain and are useless without the running, authenticated server.
 */
export const DEFAULT_PORT = 8765;
export const SERVER_CONFIG_PATH = join(CONFIG_DIR, "server.json");

export interface ServerConfig {
  port: number;
  token: string;
  url: string;
}

export function loadServerConfig(): ServerConfig | null {
  if (!existsSync(SERVER_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
    if (parsed && typeof parsed.token === "string" && typeof parsed.port === "number") {
      return { port: parsed.port, token: parsed.token, url: urlFor(parsed.port) };
    }
  } catch {
    // fall through
  }
  return null;
}

function urlFor(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** Get-or-create the server config, keeping the existing token if present. */
export function ensureServerConfig(port: number = DEFAULT_PORT): ServerConfig {
  const existing = loadServerConfig();
  const token = existing?.token ?? randomBytes(24).toString("base64url");
  const cfg: ServerConfig = { port, token, url: urlFor(port) };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(SERVER_CONFIG_PATH, 0o600); // enforce perms even if the file pre-existed
  restrictWindowsAcl(SERVER_CONFIG_PATH);
  return cfg;
}

/**
 * POSIX mode bits (the 0600 above) do not restrict access on Windows, so on
 * win32 apply an ACL that removes inherited permissions and grants only the
 * current user full control. Best-effort: any failure is logged, never fatal,
 * since the loopback bind and bearer token remain the primary defenses.
 */
function restrictWindowsAcl(path: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME || process.env.USER;
  if (!user) {
    logger.warn({ path }, "no USERNAME env; skipping ACL restriction, token file may be readable by other local users");
    return;
  }
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch (e) {
    logger.warn(
      { path, err: e instanceof Error ? e.message : String(e) },
      "icacls ACL restriction failed; token file may be readable by other local users",
    );
  }
}
