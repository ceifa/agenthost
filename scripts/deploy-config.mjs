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

// wrangler.jsonc allows // and /* */ comments; strip them outside strings.
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
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

// Writes worker/wrangler.deploy.json from wrangler.jsonc plus the overrides and
// returns its path, or removes it and returns null when nothing is overridden.
export function writeWranglerConfig() {
  loadDeployEnv();
  const env = process.env;
  if (!OVERRIDES.some((name) => env[name])) {
    rmSync(generatedConfig, { force: true });
    return null;
  }

  const config = readWranglerConfig();
  delete config.$schema;
  if (env.CLOUDFLARE_ACCOUNT_ID) {
    config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
    config.vars.R2_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
  }
  if (env.APEX_HOST || env.ZONE_NAME) {
    const apex = apexHost();
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

  writeFileSync(generatedConfig, `${JSON.stringify(config, null, 2)}\n`);
  return fileURLToPath(generatedConfig);
}
