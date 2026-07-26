// Dump this build's MCP tool surface — every tool name, title, description,
// JSON input schema and annotation, plus the server instructions — as canonical
// JSON.
//
// Why it exists: the tool vocabulary is a contract. SPEC-287 (in the private
// `chat` monorepo) splits the portable half of this server into `anymail-core`
// so a second, hosted deployment can register the SAME tools; the whole design
// rests on the two surfaces being indistinguishable to an agent. That claim is
// only worth anything if it is checked, and it can only be checked against a
// recorded surface.
//
//   npx tsx scripts/tool-surface.ts > /tmp/before.json
//   …refactor…
//   npx tsx scripts/tool-surface.ts | diff /tmp/before.json -
//
// Safe to run anywhere: listing tools evaluates the schema literals and nothing
// else — no IMAP connection, no keychain read, no registry file.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/node/mcp/server.js";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = buildServer();
await server.connect(serverTransport);

const client = new Client({ name: "tool-surface", version: "0" });
await client.connect(clientTransport);

const { tools } = await client.listTools();
console.log(
  JSON.stringify(
    {
      instructions: client.getInstructions(),
      tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
    },
    null,
    2,
  ),
);

await client.close();
await server.close();
process.exit(0);
