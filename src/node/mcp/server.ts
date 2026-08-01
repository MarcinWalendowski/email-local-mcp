import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildInstructions, registerTools } from "../../core/index.js";
import { nodeHost } from "../host.js";
import { closeAll, startIdleSweep } from "../providers/index.js";
import { logger } from "../logger.js";

// What this deployment is. Everything after it — the id model, the capability
// caveats, the bulk continuation protocol — describes the tools rather than the
// host, and lives in `email-local-core` so a second deployment says it identically.
const OVERVIEW =
  "Multi-account, multi-provider email over IMAP/SMTP (Gmail, plus iCloud / Fastmail / generic IMAP).";

const INSTRUCTIONS = buildInstructions(OVERVIEW);

/** Build a fully-registered MCP server. Shared by the stdio and HTTP transports. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "email-local-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, nodeHost);
  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = buildServer();
  startIdleSweep();

  const shutdown = () => {
    void closeAll().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("email-local-mcp stdio server ready");
}
