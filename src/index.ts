#!/usr/bin/env node
import { CLI_COMMANDS, runCli } from "./node/cli.js";
import { runStdioServer } from "./node/mcp/server.js";
import { runHttpServer } from "./node/http/server.js";
import { DEFAULT_PORT } from "./node/server-config.js";
import { importLegacyStateOnStartup } from "./node/migrate.js";

// Modes:
//   (no args)              → stdio MCP server (how stdio agents launch us)
//   --http [--port N]      → always-on local HTTP MCP + admin server
//   <known subcommand>     → CLI (add/list/test/install/…)
const argv = process.argv.slice(2);
const arg = argv[0];

function fatal(e: unknown): never {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

// Before any mode reads the registry. This is the one line every entry point
// crosses, which is the whole reason it lives here: hooking the three modes
// separately means the fourth one added later silently does not migrate.
//
// The one exception is `import-legacy` itself. Without it the hook always wins
// the race, seals the marker, and the explicit command a user runs to find out
// WHY nothing came across answers "already imported" every time.
if (arg !== "import-legacy") importLegacyStateOnStartup();

if (arg === "--http") {
  const pIdx = argv.indexOf("--port");
  const port = pIdx >= 0 && argv[pIdx + 1] ? Number(argv[pIdx + 1]) : DEFAULT_PORT;
  runHttpServer(port).catch(fatal);
} else if (arg && CLI_COMMANDS.has(arg)) {
  runCli(argv)
    // Honour process.exitCode rather than hardcoding 0. A subcommand that sets
    // it to signal partial failure (import-legacy, when a credential could not
    // be read) had it silently overwritten here, so the command could never
    // report anything but success to a script.
    .then(() => process.exit(process.exitCode ?? 0))
    .catch(fatal);
} else {
  runStdioServer().catch(fatal);
}
