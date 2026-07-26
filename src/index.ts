#!/usr/bin/env node
import { CLI_COMMANDS, runCli } from "./node/cli.js";
import { runStdioServer } from "./node/mcp/server.js";
import { runHttpServer } from "./node/http/server.js";
import { DEFAULT_PORT } from "./node/server-config.js";

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

if (arg === "--http") {
  const pIdx = argv.indexOf("--port");
  const port = pIdx >= 0 && argv[pIdx + 1] ? Number(argv[pIdx + 1]) : DEFAULT_PORT;
  runHttpServer(port).catch(fatal);
} else if (arg && CLI_COMMANDS.has(arg)) {
  runCli(argv)
    .then(() => process.exit(0))
    .catch(fatal);
} else {
  runStdioServer().catch(fatal);
}
