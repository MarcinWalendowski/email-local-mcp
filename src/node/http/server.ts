import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../mcp/server.js";
import {
  addAccount,
  listPublic,
  removeAccount,
  setDefault,
  testAccount,
} from "../accounts.js";
import { runInstall } from "../install.js";
import { DEFAULT_PORT, ensureServerConfig, type ServerConfig } from "../server-config.js";
import { closeAll, startIdleSweep } from "../providers/index.js";
import { logger } from "../logger.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  if (res.headersSent) return;
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const text = (await readBody(req)).trim();
  return text ? JSON.parse(text) : undefined;
}

/** DNS-rebinding defense: a browser always sends Origin; non-browser MCP clients omit it. */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), token);
}

// The stdio entrypoint (dist/index.js), used when registering Claude Desktop.
function engineEntry(): string {
  return fileURLToPath(new URL("../index.js", import.meta.url));
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Stateless: a fresh server + transport per request. The IMAP pool is a
  // module-level singleton, so warm connections persist across requests.
  const mcp = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  const body = req.method === "POST" ? await readJson(req) : undefined;
  await transport.handleRequest(req, res, body);
}

async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<void> {
  const method = req.method ?? "GET";

  if (path === "/admin/health" && method === "GET") {
    return sendJson(res, 200, { ok: true, accounts: listPublic().length });
  }
  if (path === "/admin/accounts" && method === "GET") {
    return sendJson(res, 200, { accounts: listPublic() });
  }
  if (path === "/admin/accounts" && method === "POST") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await readJson(req)) as any;
    try {
      return sendJson(res, 201, { account: await addAccount(body ?? {}) });
    } catch (e) {
      return sendJson(res, 400, { error: msg(e) });
    }
  }
  if (path === "/admin/default" && method === "POST") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await readJson(req)) as any;
    try {
      return sendJson(res, 200, { account: setDefault(body?.email) });
    } catch (e) {
      return sendJson(res, 400, { error: msg(e) });
    }
  }
  if (path === "/admin/install" && method === "POST") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await readJson(req)) as any;
    return sendJson(res, 200, runInstall({ entryJs: engineEntry(), all: Boolean(body?.all) }));
  }
  if (path.startsWith("/admin/accounts/")) {
    const rest = decodeURIComponent(path.slice("/admin/accounts/".length));
    if (rest.endsWith("/test") && method === "POST") {
      const email = rest.slice(0, -"/test".length);
      try {
        return sendJson(res, 200, await testAccount(email));
      } catch (e) {
        return sendJson(res, 400, { error: msg(e) });
      }
    }
    if (method === "DELETE") {
      removeAccount(rest);
      return sendJson(res, 200, { removed: rest });
    }
  }
  return sendJson(res, 404, { error: "not found" });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  if (!originAllowed(req)) return sendJson(res, 403, { error: "forbidden origin" });
  if (!authorized(req, cfg.token)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return sendJson(res, 401, { error: "unauthorized" });
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/mcp") return handleMcp(req, res);
  if (url.pathname.startsWith("/admin/")) return handleAdmin(req, res, url.pathname);
  return sendJson(res, 404, { error: "not found" });
}

export async function runHttpServer(port: number = DEFAULT_PORT): Promise<void> {
  const cfg = ensureServerConfig(port);
  startIdleSweep();

  const server = http.createServer((req, res) => {
    handle(req, res, cfg).catch((e) => {
      logger.error({ err: msg(e) }, "request failed");
      sendJson(res, 500, { error: msg(e) });
    });
  });

  // Bind to loopback ONLY — never expose the mailbox surface to the network.
  server.listen(cfg.port, "127.0.0.1", () => {
    logger.info({ url: cfg.url }, "anymail-mcp http server ready");
  });

  const shutdown = () => {
    server.close();
    void closeAll().finally(() => process.exit(0));
  };
  // POSIX signal cleanup. SIGINT (Ctrl+C) is delivered on all platforms; SIGTERM
  // is effectively never raised on Windows, where the process is stopped by the
  // supervisor or console close instead. The registration is harmless there, and
  // nothing depends on SIGTERM firing for a correct shutdown.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
