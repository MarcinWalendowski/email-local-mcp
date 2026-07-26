import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { addAccount, listPublic, removeAccount, setDefault, testAccount } from "./accounts.js";
import { loadAccounts } from "./registry.js";
import { closeAll } from "./providers/index.js";
import type { ConnectionConfig, ProviderId } from "../core/index.js";
import { runInstall } from "./install.js";
import { ensureServerConfig } from "./server-config.js";
import { credentialStoreName } from "./keychain.js";

const KNOWN_PROVIDERS: ProviderId[] = ["gmail", "icloud", "fastmail", "imap"];

/** Build the (provider, connection) pair from CLI flags for `add`. */
function providerFromFlags(flags: Record<string, string | boolean>): {
  provider: ProviderId;
  connection?: ConnectionConfig;
} {
  const provider = (typeof flags.provider === "string" ? flags.provider : "gmail") as ProviderId;
  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown --provider "${provider}". One of: ${KNOWN_PROVIDERS.join(", ")}.`);
  }
  if (provider !== "imap") return { provider };

  const imapHost = typeof flags["imap-host"] === "string" ? flags["imap-host"] : undefined;
  const smtpHost = typeof flags["smtp-host"] === "string" ? flags["smtp-host"] : undefined;
  if (!imapHost || !smtpHost) {
    throw new Error("--provider imap requires --imap-host and --smtp-host.");
  }
  const starttls = Boolean(flags["smtp-starttls"]);
  const connection: ConnectionConfig = {
    imapHost,
    imapPort: flags["imap-port"] ? Number(flags["imap-port"]) : 993,
    smtpHost,
    smtpPort: flags["smtp-port"] ? Number(flags["smtp-port"]) : starttls ? 587 : 465,
    smtpSecure: !starttls,
  };
  return { provider, connection };
}

export const CLI_COMMANDS = new Set([
  "add",
  "list",
  "remove",
  "test",
  "default",
  "install",
  "token",
  "help",
  "--help",
  "-h",
]);

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The compiled entry point (dist/index.js) next to this file — used for stdio install. */
function entryJsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function parseFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function promptSecret(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Suppress echo of typed characters, but still show the prompt.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(query)) process.stdout.write(query);
    };
    rl.question(query, (value) => {
      rl.close();
      process.stdout.write("\n");
      resolve(value);
    });
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.GMAIL_APP_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return promptSecret("App Password (from myaccount.google.com/apppasswords): ");
}

function usage(): void {
  const store = credentialStoreName();
  console.log(
    [
      `AnyMail MCP: connect multiple Gmail accounts to your AI agent (IMAP/SMTP, App Passwords in the ${store})`,
      "",
      "Usage:",
      "  anymail-mcp                         Run the MCP server over stdio (how stdio agents launch it)",
      "  anymail-mcp --http [--port 8765]    Run the always-on local HTTP MCP + admin server",
      "  anymail-mcp add <email> [flags]     Add an account (prompts for App Password)",
      "      --provider <id>              gmail (default) | icloud | fastmail | imap",
      "      --imap-host / --smtp-host    Required for --provider imap (+ --imap-port/--smtp-port/--smtp-starttls)",
      '      --name "Full Name"           Display name',
      "      --default                    Make this the default account",
      "      --read-only                  Refuse all write operations for this account",
      "  anymail-mcp list                    List configured accounts",
      "  anymail-mcp test [email]            Verify IMAP + SMTP login (default account if omitted)",
      "  anymail-mcp default <email>         Set the default account",
      `  anymail-mcp remove <email>          Remove an account (${store} + registry)`,
      "  anymail-mcp install [--all]         Register this MCP into detected agents",
      "  anymail-mcp token                   Print the local HTTP server URL + bearer token",
      "  anymail-mcp help                    This help",
      "",
      "The App Password can also be piped or set via GMAIL_APP_PASSWORD.",
    ].join("\n"),
  );
}

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  try {
    switch (cmd) {
      case "add": {
        const email = positionals[0];
        if (!email)
          throw new Error(
            'Usage: anymail-mcp add <email> [--provider gmail|icloud|fastmail|imap] [--name "Name"] [--default] [--read-only]',
          );
        const { provider, connection } = providerFromFlags(flags);
        const appPassword = await readPassword();
        process.stderr.write(`Verifying ${email} (${provider}) …\n`);
        const acct = await addAccount({
          email,
          appPassword,
          provider,
          connection,
          displayName: typeof flags.name === "string" ? flags.name : undefined,
          default: Boolean(flags.default),
          readOnly: Boolean(flags["read-only"]),
        });
        console.log(
          `✓ Added ${acct.email} [${acct.provider}]${acct.default ? " (default)" : ""}${acct.readOnly ? " (read-only)" : ""}`,
        );
        break;
      }

      case "list": {
        const accounts = listPublic();
        if (!accounts.length) {
          console.log("No accounts configured. Add one:  anymail-mcp add <email>");
          break;
        }
        for (const a of accounts) {
          const mark = a.default ? "*" : " ";
          const prov = ` [${a.provider}]`;
          const ro = a.readOnly ? " (read-only)" : "";
          const warn = a.credentialPresent
            ? ""
            : `  (⚠ no ${credentialStoreName()} password; re-run add)`;
          console.log(`${mark} ${a.email}${prov}${ro}${warn}`);
        }
        break;
      }

      case "test": {
        const email =
          positionals[0] ??
          loadAccounts().find((a) => a.default)?.email ??
          loadAccounts()[0]?.email;
        if (!email) throw new Error("No accounts configured. Add one:  anymail-mcp add <email>");
        const { mailboxes } = await testAccount(email);
        console.log(`✓ IMAP + SMTP OK for ${email}`);
        console.log(
          `  inbox=${mailboxes.inbox}  all=${mailboxes.all ?? "?"}  trash=${mailboxes.trash ?? "?"}  drafts=${mailboxes.drafts ?? "?"}  sent=${mailboxes.sent ?? "?"}`,
        );
        break;
      }

      case "default": {
        const email = positionals[0];
        if (!email) throw new Error("Usage: anymail-mcp default <email>");
        const acct = setDefault(email);
        console.log(`✓ Default account set to ${acct.email}`);
        break;
      }

      case "remove": {
        const email = positionals[0];
        if (!email) throw new Error("Usage: anymail-mcp remove <email>");
        removeAccount(email);
        console.log(`✓ Removed ${email}`);
        break;
      }

      case "install": {
        const result = runInstall({ entryJs: entryJsPath(), all: Boolean(flags.all) });
        console.log("Registered AnyMail MCP into agents:\n" + result.lines.join("\n"));
        console.log(`\nHTTP agents point at ${result.url} (bearer token injected).`);
        console.log("Restart each agent to load the server.");
        break;
      }

      case "token": {
        const cfg = ensureServerConfig();
        console.log(`url:   ${cfg.url}`);
        console.log(`token: ${cfg.token}`);
        break;
      }

      case "help":
      case "--help":
      case "-h":
      default:
        usage();
    }
  } finally {
    await closeAll();
  }
}
