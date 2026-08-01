/**
 * cli.test.ts — the dispatch gate and the switch must agree.
 *
 * `src/index.ts` decides what to do with `argv[0]` by asking `CLI_COMMANDS`.
 * `runCli` then decides what to *run* with a `switch`. Those are two independent
 * lists of the same thing, maintained by hand, and when they disagree the
 * failure is silent in the worst direction:
 *
 *   - A verb in the SWITCH but not the SET does not error. It falls through to
 *     `runStdioServer()`, which starts an MCP server on stdio and waits. To the
 *     user that is a hang with no output, and nothing anywhere says "unknown
 *     command". `connect` shipped like that and was caught only by running it.
 *   - A verb in the SET but not the SWITCH reaches `runCli` and falls out of the
 *     switch entirely — a command that is advertised and does nothing.
 *
 * Neither shows up in a typecheck: both lists are just strings. So the check is
 * a grep over this file's own source, which is exact and cannot rot in the way a
 * third hand-maintained list would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLI_COMMANDS } from "./cli.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const src = readFileSync(SRC, "utf8");

/**
 * Every `case "x":` label of the TOP-LEVEL `switch (cmd)`, and only that one.
 *
 * `runCli` contains a nested switch (over `import-legacy`'s outcome), whose
 * labels are not commands — a naive match reports `already-imported` and friends
 * as undispatched verbs. The depth is read from the first label rather than
 * hardcoded, so reformatting the file cannot quietly change which switch this
 * test is looking at.
 */
function switchVerbs(): Set<string> {
  const body = src.slice(src.indexOf("switch (cmd) {"));
  const first = body.match(/^([ \t]*)case "/m);
  assert.ok(first, "could not find the first case label — this test has gone stale");
  const at = new RegExp(`^${first[1]}case "([^"]+)":`, "gm");
  return new Set([...body.matchAll(at)].map((m) => m[1]));
}

test("the parse gate and the switch agree in both directions", () => {
  const verbs = switchVerbs();
  assert.ok(verbs.size > 5, `parsed only ${verbs.size} case labels — the regex has gone stale`);

  const missingFromSet = [...verbs].filter((v) => !CLI_COMMANDS.has(v));
  assert.deepEqual(
    missingFromSet,
    [],
    `implemented but not dispatched — these would silently start the MCP server instead: ${missingFromSet.join(", ")}`,
  );

  const missingFromSwitch = [...CLI_COMMANDS].filter((v) => !verbs.has(v));
  assert.deepEqual(
    missingFromSwitch,
    [],
    `dispatched but not implemented — these would do nothing: ${missingFromSwitch.join(", ")}`,
  );
});

test("every command the usage text advertises is a real command", () => {
  // The third place a verb can be named, and the one a user reads. A command in
  // `help` that does not exist is indistinguishable from a typo in their shell.
  const usage = src.slice(src.indexOf("function usage()"), src.indexOf("export async function runCli"));
  const advertised = new Set(
    [...usage.matchAll(/email-local-mcp (?!--)([a-z][a-z-]*)/g)].map((m) => m[1]),
  );
  assert.ok(advertised.size > 5, `parsed only ${advertised.size} advertised verbs — regex stale`);

  for (const verb of advertised) {
    assert.ok(CLI_COMMANDS.has(verb), `usage advertises \`${verb}\`, which is not a CLI command`);
  }
});
