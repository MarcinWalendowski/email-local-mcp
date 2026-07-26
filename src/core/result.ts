import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Return a tool result that carries the data BOTH as structuredContent and as a
 * JSON text block. Content-only MCP clients (which ignore structuredContent
 * unless an outputSchema is declared) still get the full payload from the text.
 */
export function ok(data: unknown, summary?: string): CallToolResult {
  const structured: Record<string, unknown> = Array.isArray(data)
    ? { items: data, count: data.length }
    : (data as Record<string, unknown>);
  const body = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text: summary ? `${summary}\n${body}` : body }],
    structuredContent: structured,
  };
}

export function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}
