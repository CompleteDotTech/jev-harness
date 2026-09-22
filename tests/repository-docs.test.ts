import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import * as api from "../src";

test("clone, CI badge, and security contacts identify this fork", () => {
  const readme = readFileSync("README.md", "utf8");
  const security = readFileSync("SECURITY.md", "utf8");
  const contacts = readFileSync(".github/ISSUE_TEMPLATE/config.yml", "utf8");
  assert.match(readme, /git clone https:\/\/github.com\/CompleteDotTech\/jev-harness.git/);
  assert.match(readme, /CompleteDotTech\/jev-harness\/actions\/workflows\/checks.yml\/badge.svg/);
  assert.doesNotMatch(readme, /TypeSafeAI\/jev-harness\/actions/);
  assert.match(readme, /TypeSafeAI community upstream/);
  for (const text of [security, contacts]) {
    assert.match(text, /CompleteDotTech\/jev-harness\/security\/advisories\/new/);
    assert.doesNotMatch(text, /TypeSafeAI\/jev-harness\/security\/advisories\/new/);
  }
  assert.doesNotMatch(security, /Private reporting is enabled on this repository/);
});

test("README root import matches actual API and all hardening notes resolve", () => {
  const readme = readFileSync("README.md", "utf8");
  const rootImport = readme.match(/import \{([^}]+)\} from "\.\/src";/);
  assert.ok(rootImport);
  assert.doesNotMatch(rootImport[1]!, /decideBase/);
  assert.equal(Object.hasOwn(api, "decideBase"), false);
  const index = readFileSync("docs/hardening/README.md", "utf8");
  const links = [...index.matchAll(/\]\((\d{2}-[^)]+\.md)\)/g)];
  assert.equal(links.length, 10);
  for (const [, file] of links) assert.equal(existsSync(`docs/hardening/${file}`), true, file);
});
