// The other half of a desktop OAuth flow: a one-shot HTTP listener on the
// loopback interface that catches the redirect the browser is sent back to.
//
// It binds 127.0.0.1 explicitly — never 0.0.0.0 — so the authorization code is
// only ever deliverable from this machine, and it stops listening the moment it
// has an answer. By default it takes an ephemeral port, which is what Google's
// "Desktop app" clients allow; `port` pins it for a registration that demands an
// exact redirect URI.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** What a single callback request means to us. */
export type CallbackOutcome =
  | { kind: "code"; code: string }
  | { kind: "error"; message: string }
  /** Not the callback (a favicon probe, a stray request) — keep waiting. */
  | { kind: "ignore" };

/**
 * Read one callback request. Pure, so the interesting failures — a mismatched
 * state, a provider-side denial — are testable without a socket.
 */
export function parseCallback(rawUrl: string, expectedState: string): CallbackOutcome {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return { kind: "ignore" };
  }
  const params = url.searchParams;
  const error = params.get("error");
  const code = params.get("code");
  if (!error && !code) return { kind: "ignore" };

  // State is checked before anything else is believed: a code arriving with the
  // wrong state is not our flow, and redeeming it would be the whole point of
  // the attack the parameter exists to stop.
  const state = params.get("state");
  if (state !== expectedState) {
    return { kind: "error", message: "Authorization response did not match this request (state mismatch). Nothing was stored; run the command again." };
  }
  if (error) {
    const detail = params.get("error_description");
    return { kind: "error", message: detail ? `${error}: ${detail}` : error };
  }
  return { kind: "code", code: code as string };
}

const PAGE = (title: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body>`;

export interface LoopbackReceiver {
  /** The exact `redirect_uri` to send in the authorization request. */
  redirectUri: string;
  /** Resolves with the authorization code, or rejects with a usable message. */
  waitForCode(): Promise<string>;
  close(): void;
}

export interface LoopbackOptions {
  /** Pin the port; omit for an ephemeral one. */
  port?: number;
  state: string;
  timeoutMs: number;
}

export async function startLoopbackReceiver(opts: LoopbackOptions): Promise<LoopbackReceiver> {
  let settle: ((outcome: CallbackOutcome) => void) | undefined;
  const first = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve;
  });

  const server: Server = createServer((req, res) => {
    const outcome = parseCallback(req.url ?? "/", opts.state);
    if (outcome.kind === "ignore") {
      res.writeHead(404).end();
      return;
    }
    const [title, detail] =
      outcome.kind === "code"
        ? ["Signed in", "Email Local MCP has the authorization. You can close this tab and go back to the terminal."]
        : ["Sign-in failed", outcome.message];
    res.writeHead(outcome.kind === "code" ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE(title, detail));
    settle?.(outcome);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });

  const addr = server.address() as AddressInfo;
  const close = (): void => {
    server.closeAllConnections?.();
    server.close();
  };

  return {
    redirectUri: `http://127.0.0.1:${addr.port}`,
    close,
    async waitForCode(): Promise<string> {
      const timeout = new Promise<never>((_, reject) => {
        const t = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for the browser to come back. Nothing was stored.`,
              ),
            ),
          opts.timeoutMs,
        );
        // Do not hold the process open just to time out.
        t.unref?.();
      });
      try {
        const outcome = await Promise.race([first, timeout]);
        if (outcome.kind === "error") throw new Error(outcome.message);
        if (outcome.kind === "ignore") throw new Error("No authorization code was received.");
        return outcome.code;
      } finally {
        close();
      }
    },
  };
}
