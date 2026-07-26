import pino from "pino";

// IMPORTANT: log to stderr (fd 2) only. fd 1 (stdout) is the MCP stdio JSON-RPC
// channel — any stray write there corrupts the protocol stream.
export const logger = pino(
  {
    level: process.env.GMAIL_MCP_LOG_LEVEL ?? "info",
    // Never let a secret or a message body reach the logs.
    redact: {
      paths: [
        "pass",
        "password",
        "appPassword",
        "auth.pass",
        "*.pass",
        "*.password",
        "content",
        "contentBase64",
        "source",
        "raw",
        "text",
        "html",
      ],
      censor: "[redacted]",
    },
  },
  pino.destination(2),
);
