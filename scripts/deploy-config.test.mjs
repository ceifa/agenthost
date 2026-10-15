import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyOverrides, parseJsonc } from "./deploy-config.mjs";

const shipped = () => parseJsonc(readFileSync(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8"));

test("parses the shipped wrangler.jsonc", () => {
  const config = shipped();
  assert.equal(config.vars.APEX_HOST, "agenthost.page");
  assert.equal(config.routes.length, 2);
});

test("strips comments but keeps comment-like text inside strings", () => {
  const config = parseJsonc(`{
    // line comment
    "url": "https://example.com/*", /* block */ "path": "a/*b*/c",
    "quote": "say \\"//hi\\""
  }`);
  assert.deepEqual(config, { url: "https://example.com/*", path: "a/*b*/c", quote: 'say "//hi"' });
});

test("accepts trailing commas, as Wrangler does", () => {
  const config = parseJsonc(`{
    "list": [1, 2, ],
    "vars": { "APEX_HOST": "x.io", /* last */ },
    "comma": ",}",
  }`);
  assert.deepEqual(config, { list: [1, 2], vars: { APEX_HOST: "x.io" }, comma: ",}" });
});

test("throws instead of hanging on an unterminated comment or string", () => {
  assert.throws(() => parseJsonc(`{ "a": 1 /* never closed`), /Unterminated comment/);
  assert.throws(() => parseJsonc(`{ "a": "never closed`), /Unterminated string/);
});

test("returns null when nothing is overridden", () => {
  assert.equal(applyOverrides(shipped(), {}), null);
  assert.equal(applyOverrides(shipped(), { APEX_HOST: "" }), null);
});

test("overrides the account, domain and bucket", () => {
  const base = shipped();
  const config = applyOverrides(base, {
    CLOUDFLARE_ACCOUNT_ID: "acct",
    APEX_HOST: "sites.example.com",
    ZONE_NAME: "example.com",
    R2_BUCKET_NAME: "my-bucket",
  });
  assert.equal(config.$schema, undefined);
  assert.equal(config.account_id, "acct");
  assert.equal(config.vars.R2_ACCOUNT_ID, "acct");
  assert.equal(config.vars.APEX_HOST, "sites.example.com");
  assert.deepEqual(config.routes, [
    { pattern: "sites.example.com/*", zone_name: "example.com" },
    { pattern: "*.sites.example.com/*", zone_name: "example.com" },
  ]);
  assert.equal(config.r2_buckets.find((b) => b.binding === "SITES").bucket_name, "my-bucket");
  assert.equal(config.vars.R2_BUCKET_NAME, "my-bucket");
  // The parsed input is left alone.
  assert.equal(base.vars.APEX_HOST, "agenthost.page");
});

test("defaults the zone to APEX_HOST", () => {
  const config = applyOverrides(shipped(), { APEX_HOST: "example.com" });
  assert.deepEqual(config.routes.map((r) => r.zone_name), ["example.com", "example.com"]);
  assert.equal(config.account_id, shipped().account_id);
});

test("ZONE_NAME alone keeps the shipped apex", () => {
  const config = applyOverrides(shipped(), { ZONE_NAME: "parent.page" });
  assert.equal(config.vars.APEX_HOST, "agenthost.page");
  assert.deepEqual(config.routes[1], { pattern: "*.agenthost.page/*", zone_name: "parent.page" });
});
