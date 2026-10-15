// Runs Wrangler in worker/ against the deploy target: the config generated
// from deploy.env when it sets anything, otherwise worker/wrangler.jsonc.
//
//   pnpm wrangler deploy
//   pnpm wrangler secret put ACCESS_AUD
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeWranglerConfig } from "./deploy-config.mjs";

const config = writeWranglerConfig();
const args = process.argv.slice(2);
const worker = fileURLToPath(new URL("../worker", import.meta.url));
// Run Wrangler's entry point with this Node directly: no shell and no pnpm
// shim, so it behaves the same on Windows.
const bin = fileURLToPath(new URL("../worker/node_modules/wrangler/bin/wrangler.js", import.meta.url));
const { status } = spawnSync(
  process.execPath,
  [bin, ...args, ...(config ? ["--config", config] : [])],
  { cwd: worker, stdio: "inherit" },
);
process.exit(status ?? 1);
