/**
 * version.test.ts - the four version sites must agree.
 *
 * The version lives in four places: package.json, the `McpServer({version})`
 * here in src/node/mcp/server.ts, and MARKETING_VERSION +
 * CURRENT_PROJECT_VERSION in app/project.yml. Only one of them is visible to
 * an agent: the MCP one, reported over `initialize`. That is also the one with
 * no other reason to be read, so it is the one that drifts, and it has -
 * silently, while package.json moved on without it.
 *
 * RELEASING.md documents the four places. This asserts them, because a release
 * checklist is followed by a person at the end of a long day and a test is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const pkgVersion = JSON.parse(read("package.json")).version as string;

test("the MCP server reports the version from package.json", () => {
  const src = read("src/node/mcp/server.ts");
  const match = src.match(/new McpServer\(\s*\{[^}]*version:\s*"([^"]+)"/);
  assert.ok(match, "could not find McpServer({ version }) in src/node/mcp/server.ts");
  assert.equal(
    match[1],
    pkgVersion,
    `the version an agent sees over initialize (${match[1]}) has drifted from package.json (${pkgVersion})`,
  );
});

test("the macOS app's marketing version tracks package.json", () => {
  const yml = read("app/project.yml");
  const marketing = yml.match(/MARKETING_VERSION:\s*"([^"]+)"/);
  assert.ok(marketing, "MARKETING_VERSION missing from app/project.yml");

  // Apple accepts 1-3 dot-separated integers and nothing else, so a prerelease
  // suffix is stripped rather than compared. 0.1.0-rc.2 is a legal npm version
  // and an illegal CFBundleShortVersionString.
  const numeric = pkgVersion.split("-")[0];
  assert.equal(
    marketing[1],
    numeric,
    `MARKETING_VERSION (${marketing[1]}) does not match package.json (${numeric})`,
  );
});

test("CURRENT_PROJECT_VERSION is an integer Sparkle can order", () => {
  const yml = read("app/project.yml");
  const build = yml.match(/CURRENT_PROJECT_VERSION:\s*"([^"]+)"/);
  assert.ok(build, "CURRENT_PROJECT_VERSION missing from app/project.yml");

  // Sparkle orders releases by CFBundleVersion. A non-integer, or one that
  // never moves, makes a release invisible to every installed copy.
  assert.match(build[1], /^\d+$/, `CURRENT_PROJECT_VERSION must be an integer, got ${build[1]}`);
});
