// Build step: copy landing/dist → public/ and admin/dist → public/admin/.
// The Worker serves both via the single ASSETS binding (one wrangler deploy).
import { cp, rm, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exists = async (p) => access(p).then(() => true).catch(() => false);

const publicDir = resolve(root, "public");
await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });

const landingDist = resolve(root, "landing/dist");
if (await exists(landingDist)) {
  await cp(landingDist, publicDir, { recursive: true });
  console.log("copied landing/dist → public/");
} else {
  console.warn("landing/dist missing — skipping");
}

const adminDist = resolve(root, "admin/dist");
if (await exists(adminDist)) {
  await cp(adminDist, resolve(publicDir, "admin"), { recursive: true });
  console.log("copied admin/dist → public/admin/");
} else {
  console.warn("admin/dist missing — skipping");
}
