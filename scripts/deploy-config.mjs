// Operator-specific deploy settings. worker/wrangler.jsonc holds the defaults;
// a git-ignored deploy.env at the repo root (see deploy.env.example) overrides
// the account, domain and bucket without editing tracked files. Environment
// variables win over deploy.env. scripts/wrangler.mjs runs Wrangler against
// the result.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const deployEnv = new URL("deploy.env", root);
const wranglerConfig = new URL("worker/wrangler.jsonc", root);
const generatedConfig = new URL("worker/wrangler.deploy.json", root);

const OVERRIDES = ["CLOUDFLARE_ACCOUNT_ID", "APEX_HOST", "ZONE_NAME", "R2_BUCKET_NAME"];

let loaded = false;
function loadDeployEnv() {
  if (loaded) return;
  loaded = true;
  // loadEnvFile keeps variables that are already set in the environment.
  if (existsSync(deployEnv)) process.loadEnvFile(fileURLToPath(deployEnv));
}

// Index just past the string literal that opens at text[start].
function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  throw new SyntaxError(`Unterminated string at position ${start}`);
}

// wrangler.jsonc allows // and /* */ comments and trailing commas, like
// Wrangler itself; strip them outside strings before handing off to JSON.parse.
export function parseJsonc(text) {
  let stripped = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      stripped += text.slice(i, end);
      i = end - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new SyntaxError(`Unterminated comment at position ${i}`);
      i = end + 1;
    } else {
      stripped += c;
    }
  }

  let out = "";
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '"') {
      const end = stringEnd(stripped, i);
      out += stripped.slice(i, end);
      i = end - 1;
    } else if (c !== "," || !/^\s*[}\]]/.test(stripped.slice(i + 1))) {
      out += c;
    }
  }
  return JSON.parse(out);
}

const readWranglerConfig = () => parseJsonc(readFileSync(wranglerConfig, "utf8"));

export function apexHost() {
  loadDeployEnv();
  return process.env.APEX_HOST || readWranglerConfig().vars.APEX_HOST;
}

// Applies the overrides in env to a parsed wrangler.jsonc. Returns null when
// nothing is overridden, so Wrangler can keep using the shipped file.
export function applyOverrides(config, env) {
  if (!OVERRIDES.some((name) => env[name])) return null;

  config = structuredClone(config);
  delete config.$schema;
  if (env.CLOUDFLARE_ACCOUNT_ID) {
    config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
    config.vars.R2_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
  }
  if (env.APEX_HOST || env.ZONE_NAME) {
    const apex = env.APEX_HOST || config.vars.APEX_HOST;
    const zone = env.ZONE_NAME || apex;
    config.vars.APEX_HOST = apex;
    config.routes = [
      { pattern: `${apex}/*`, zone_name: zone },
      { pattern: `*.${apex}/*`, zone_name: zone },
    ];
  }
  if (env.R2_BUCKET_NAME) {
    for (const bucket of config.r2_buckets) {
      if (bucket.binding === "SITES") bucket.bucket_name = env.R2_BUCKET_NAME;
    }
    config.vars.R2_BUCKET_NAME = env.R2_BUCKET_NAME;
  }
  return config;
}

// Writes worker/wrangler.deploy.json from wrangler.jsonc plus the overrides and
// returns its path, or removes it and returns null when nothing is overridden.
export function writeWranglerConfig() {
  loadDeployEnv();
  const config = applyOverrides(readWranglerConfig(), process.env);
  if (!config) {
    rmSync(generatedConfig, { force: true });
    return null;
  }
  writeFileSync(generatedConfig, `${JSON.stringify(config, null, 2)}\n`);
  return fileURLToPath(generatedConfig);
}
