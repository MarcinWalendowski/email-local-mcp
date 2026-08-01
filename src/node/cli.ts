import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  addAccount,
  listPublic,
  removeAccount,
  setDefault,
  signInAccount,
  signOutAccount,
  testAccount,
} from "./accounts.js";
import { loadAccounts } from "./registry.js";
import { closeAll } from "./providers/index.js";
import type { ConnectionConfig, ProviderId } from "../core/index.js";
import { runInstall } from "./install.js";
import { ensureServerConfig } from "./server-config.js";
import { credentialStoreName } from "./keychain.js";
import { issuerAliases, resolveIssuer, type OAuthIssuer } from "./oauth/issuers.js";

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

/** Everything `login` needs, read out of the flags it was given. */
function oauthFromFlags(flags: Record<string, string | boolean>): {
  issuer: OAuthIssuer;
  clientId: string;
  clientSecret?: string;
  tenant?: string;
  scopes?: string[];
  redirectPort?: number;
} {
  const str = (k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const issuer = resolveIssuer(str("provider") ?? "gmail");

  const clientId = str("client-id") ?? process.env.EMAIL_LOCAL_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      `--client-id is required. A local sign-in needs an OAuth client you register yourself, because this app cannot ship one ` +
        `(mail scopes are "restricted", so a public client id would need its own verification). ` +
        `Create one at ${issuer.registrationDocs} and see docs/oauth.md.`,
    );
  }

  const clientSecret = str("client-secret") ?? process.env.EMAIL_LOCAL_OAUTH_CLIENT_SECRET;
  if (issuer.usesClientSecret && !clientSecret) {
    throw new Error(
      `--client-secret is required for ${issuer.label}: its token endpoint rejects the exchange without one, even for ` +
        `a "Desktop app" client (Google documents that secret as not actually secret for installed apps). ` +
        `It is stored in the ${credentialStoreName()}, never in the registry.`,
    );
  }

  const scopes = str("scopes")
    ?.split(/[\s,]+/)
    .filter(Boolean);
  const portFlag = str("redirect-port");
  const redirectPort = portFlag ? Number(portFlag) : undefined;
  if (redirectPort !== undefined && (!Number.isInteger(redirectPort) || redirectPort < 1 || redirectPort > 65535)) {
    throw new Error(`--redirect-port must be a port number, got "${portFlag}".`);
  }

  return {
    issuer,
    clientId,
    clientSecret: issuer.usesClientSecret ? clientSecret : undefined,
    tenant: str("tenant"),
    scopes: scopes?.length ? scopes : undefined,
    redirectPort,
  };
}

export const CLI_COMMANDS = new Set([
  "add",
  "login",
  "logout",
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
      `Email Local MCP: connect multiple email accounts to your AI agent (IMAP/SMTP, App Passwords or OAuth tokens in the ${store})`,
      "",
      "Usage:",
      "  email-local-mcp                         Run the MCP server over stdio (how stdio agents launch it)",
      "  email-local-mcp --http [--port 8765]    Run the always-on local HTTP MCP + admin server",
      "  email-local-mcp add <email> [flags]     Add an account (prompts for App Password)",
      "      --provider <id>              gmail (default) | icloud | fastmail | imap",
      "      --imap-host / --smtp-host    Required for --provider imap (+ --imap-port/--smtp-port/--smtp-starttls)",
      '      --name "Full Name"           Display name',
      "      --default                    Make this the default account",
      "      --read-only                  Refuse all write operations for this account",
      "  email-local-mcp login <email> [flags]   Add an account by signing in in your browser (OAuth) instead of an App Password",
      `      --provider <id>              gmail (default) | microsoft  [${issuerAliases().join(" / ")}]`,
      "      --client-id <id>             Required: your own OAuth client (see docs/oauth.md); or EMAIL_LOCAL_OAUTH_CLIENT_ID",
      "      --client-secret <secret>     Required for Google desktop clients; or EMAIL_LOCAL_OAUTH_CLIENT_SECRET",
      "      --tenant <id>                Microsoft only: directory to sign in against (default common)",
      '      --scopes "a b"               Override the default IMAP/SMTP scopes',
      "      --redirect-port <n>          Pin the loopback port (default: any free one)",
      "      --no-browser                 Print the URL instead of opening a browser",
      '      --name "Full Name" / --default / --read-only   As for add',
      "  email-local-mcp logout <email>          Forget an OAuth account's tokens (and revoke them where possible); keeps the account",
      "  email-local-mcp list                    List configured accounts",
      "  email-local-mcp test [email]            Verify IMAP + SMTP login (default account if omitted)",
      "  email-local-mcp default <email>         Set the default account",
      `  email-local-mcp remove <email>          Remove an account (${store} + registry)`,
      "  email-local-mcp install [--all]         Register this MCP into detected agents",
      "  email-local-mcp token                   Print the local HTTP server URL + bearer token",
      "  email-local-mcp help                    This help",
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
            'Usage: email-local-mcp add <email> [--provider gmail|icloud|fastmail|imap] [--name "Name"] [--default] [--read-only]',
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

      case "login": {
        const email = positionals[0];
        if (!email) {
          throw new Error(
            "Usage: email-local-mcp login <email> --provider gmail|microsoft --client-id <id> [--client-secret <secret>] [--tenant <id>]",
          );
        }
        const oauth = oauthFromFlags(flags);
        const acct = await signInAccount({
          ...oauth,
          email,
          openInBrowser: !flags["no-browser"],
          onPrompt: (m) => process.stderr.write(`${m}\n`),
          displayName: typeof flags.name === "string" ? flags.name : undefined,
          default: Boolean(flags.default),
          readOnly: Boolean(flags["read-only"]),
        });
        console.log(
          `✓ Signed in ${acct.email} [${acct.provider} · ${oauth.issuer.id} oauth]${acct.default ? " (default)" : ""}${acct.readOnly ? " (read-only)" : ""}`,
        );
        break;
      }

      case "logout": {
        const email = positionals[0];
        if (!email) throw new Error("Usage: email-local-mcp logout <email>");
        const { revoked } = await signOutAccount(email);
        console.log(
          `✓ Signed out ${email}${revoked ? " (token revoked at the provider)" : ""}. Sign in again:  email-local-mcp login ${email}`,
        );
        break;
      }

      case "list": {
        const accounts = listPublic();
        if (!accounts.length) {
          console.log("No accounts configured. Add one:  email-local-mcp add <email>");
          break;
        }
        const authOf = new Map(loadAccounts().map((a) => [a.email.toLowerCase(), a.auth]));
        for (const a of accounts) {
          const mark = a.default ? "*" : " ";
          const auth = authOf.get(a.email.toLowerCase());
          const prov = ` [${a.provider}${auth?.kind === "oauth" ? ` · ${auth.issuer} oauth` : ""}]`;
          const ro = a.readOnly ? " (read-only)" : "";
          const warn = a.credentialPresent
            ? ""
            : auth?.kind === "oauth"
              ? "  (⚠ signed out; re-run login)"
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
        if (!email) throw new Error("No accounts configured. Add one:  email-local-mcp add <email>");
        const { mailboxes } = await testAccount(email);
        console.log(`✓ IMAP + SMTP OK for ${email}`);
        console.log(
          `  inbox=${mailboxes.inbox}  all=${mailboxes.all ?? "?"}  trash=${mailboxes.trash ?? "?"}  drafts=${mailboxes.drafts ?? "?"}  sent=${mailboxes.sent ?? "?"}`,
        );
        break;
      }

      case "default": {
        const email = positionals[0];
        if (!email) throw new Error("Usage: email-local-mcp default <email>");
        const acct = setDefault(email);
        console.log(`✓ Default account set to ${acct.email}`);
        break;
      }

      case "remove": {
        const email = positionals[0];
        if (!email) throw new Error("Usage: email-local-mcp remove <email>");
        await removeAccount(email);
        console.log(`✓ Removed ${email}`);
        break;
      }

      case "install": {
        const result = runInstall({ entryJs: entryJsPath(), all: Boolean(flags.all) });
        console.log("Registered Email Local MCP into agents:\n" + result.lines.join("\n"));
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
