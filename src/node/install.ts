import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureServerConfig } from "./server-config.js";

/**
 * One-click MCP registration — the engine-level primitive the menu-bar app's
 * "Install into agents" button calls. HTTP agents get the always-on server URL
 * plus a bearer token; Claude Desktop (stdio-only) gets the stdio command,
 * which spawns its own engine sharing the same Keychain + registry.
 */
export interface InstallCtx {
  nodePath: string;
  entryJs: string;
  url: string;
  token: string;
}

export interface AgentTarget {
  id: string;
  name: string;
  /** Resolved config path for the current platform, or null when the agent has
   * no known config location on this OS (so it is skipped, not written). */
  configPath: string | null;
  /** Top-level key holding the server map. */
  key: "mcpServers" | "servers";
  transport: "http" | "stdio";
  buildEntry: (ctx: InstallCtx) => Record<string, unknown>;
}

/** The static parts of an agent target, independent of the current platform. */
type AgentDef = Omit<AgentTarget, "configPath">;

function bearer(ctx: InstallCtx): Record<string, string> {
  return { Authorization: `Bearer ${ctx.token}` };
}

const AGENT_DEFS: AgentDef[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    key: "mcpServers",
    transport: "stdio",
    buildEntry: (ctx) => ({ command: ctx.nodePath, args: [ctx.entryJs] }),
  },
  {
    id: "claude-code",
    name: "Claude Code (user scope)",
    key: "mcpServers",
    transport: "http",
    buildEntry: (ctx) => ({ type: "http", url: ctx.url, headers: bearer(ctx) }),
  },
  {
    id: "cursor",
    name: "Cursor",
    key: "mcpServers",
    transport: "http",
    buildEntry: (ctx) => ({ url: ctx.url, headers: bearer(ctx) }),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    key: "mcpServers",
    transport: "http",
    buildEntry: (ctx) => ({ serverUrl: ctx.url, headers: bearer(ctx) }),
  },
  {
    id: "vscode",
    name: "VS Code (Copilot, user)",
    key: "servers",
    transport: "http",
    buildEntry: (ctx) => ({ type: "http", url: ctx.url, headers: bearer(ctx) }),
  },
];

/** Windows Roaming AppData, from %APPDATA% or the conventional fallback. */
function appDataDir(home: string, env: NodeJS.ProcessEnv): string {
  return env.APPDATA || join(home, "AppData", "Roaming");
}

/** Linux XDG config root, from $XDG_CONFIG_HOME or the ~/.config default. */
function xdgConfigDir(home: string, env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(home, ".config");
}

/**
 * Resolve an agent's config path for a given platform. Returns null when the
 * agent has no well-known config location on that OS, so `--all` skips it
 * instead of writing a bogus tree (e.g. a macOS `~/Library/...` path on Linux).
 *
 * The `platform`/`home`/`env` params default to the current process and exist
 * so the branch selection can be unit-tested; at runtime `join` uses the native
 * path separator, which always matches `process.platform`.
 */
export function resolveConfigPath(
  id: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  switch (id) {
    // Per-OS application config directories.
    case "claude-desktop":
      if (platform === "darwin")
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return join(appDataDir(home, env), "Claude", "claude_desktop_config.json");
      if (platform === "linux") return join(xdgConfigDir(home, env), "Claude", "claude_desktop_config.json");
      return null;
    case "vscode":
      if (platform === "darwin")
        return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
      if (platform === "win32") return join(appDataDir(home, env), "Code", "User", "mcp.json");
      if (platform === "linux") return join(xdgConfigDir(home, env), "Code", "User", "mcp.json");
      return null;
    // Home-relative dotfiles: identical layout on every OS.
    case "claude-code":
      return join(home, ".claude.json");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    default:
      return null;
  }
}

export const AGENTS: AgentTarget[] = AGENT_DEFS.map((def) => ({
  ...def,
  configPath: resolveConfigPath(def.id),
}));

/** True when the agent looks installed (its config or parent app dir exists). */
export function detected(t: AgentTarget): boolean {
  if (!t.configPath) return false;
  return existsSync(t.configPath) || existsSync(dirname(t.configPath));
}

export function installInto(
  target: AgentTarget,
  serverName: string,
  entry: Record<string, unknown>,
): { created: boolean } {
  const { configPath } = target;
  if (!configPath) {
    throw new Error(`${target.name} has no config location on ${process.platform}`);
  }
  const created = !existsSync(configPath);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  if (!created) {
    const raw = readFileSync(configPath, "utf8").trim();
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        // Never clobber an existing config we can't parse.
        throw new Error(`existing config at ${configPath} is not valid JSON; left untouched`);
      }
    }
  }

  if (!json[target.key] || typeof json[target.key] !== "object") json[target.key] = {};
  json[target.key][serverName] = entry;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  return { created };
}

export function runInstall(opts: { entryJs: string; all?: boolean }): { lines: string[]; url: string } {
  const cfg = ensureServerConfig();
  const ctx: InstallCtx = {
    nodePath: process.execPath,
    entryJs: opts.entryJs,
    url: cfg.url,
    token: cfg.token,
  };
  const lines: string[] = [];
  for (const t of AGENTS) {
    if (!t.configPath) {
      lines.push(`·  ${t.name}: not available on ${process.platform} (skipped)`);
      continue;
    }
    if (!opts.all && !detected(t)) {
      lines.push(`·  ${t.name}: not detected (skipped; use --all to force)`);
      continue;
    }
    try {
      const { created } = installInto(t, "anymail-mcp", t.buildEntry(ctx));
      lines.push(`✓  ${t.name} [${t.transport}]: ${created ? "created" : "updated"} ${t.configPath}`);
    } catch (e) {
      lines.push(`✗  ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { lines, url: cfg.url };
}
