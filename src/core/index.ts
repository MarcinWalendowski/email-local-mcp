// anymail-core — the portable half of AnyMail MCP.
//
// Everything here runs unchanged on Node and on a V8 isolate (Cloudflare
// Workers, Deno, a browser): the tool vocabulary, the result shape, the
// `MailProvider` contract, and the `MailHost` seam a deployment implements. What
// it deliberately does NOT contain is any way to *get* mail — no IMAP, no HTTP
// client, no credential store. Those are the host's, and there are two of them:
// the local macOS app (IMAP/SMTP, App Passwords in the Keychain) and a hosted
// Worker (provider REST APIs, per-user OAuth).
//
// The point of the package is that both call `registerTools`, so an agent cannot
// tell which one it is talking to. See SPEC-287.

export { registerTools } from "./tools.js";
export { ok, fail } from "./result.js";
export { TOOL_INSTRUCTIONS, buildInstructions } from "./instructions.js";

export type * from "./provider.js";
export type * from "./accounts.js";
