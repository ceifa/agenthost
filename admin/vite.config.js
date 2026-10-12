import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { apexHost } from "../scripts/deploy-config.mjs";

// Read from worker/wrangler.jsonc (override via APEX_HOST). The admin surface
// lives on admin.{APEX_HOST}.
const APEX_HOST = apexHost();

// Built to admin/dist → copied to public/admin/. Assets are referenced
// root-absolute (/assets/...); the Worker's admin host maps those under /admin/.
export default defineConfig({
  plugins: [svelte()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  // Local interactive dev: proxy admin API to the running worker, adding the
  // ?__host override so it routes to the admin surface (DEV_MODE bypasses Access).
  server: {
    proxy: {
      "/admin/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path + (path.includes("?") ? "&" : "?") + `__host=admin.${APEX_HOST}`,
      },
    },
  },
});
