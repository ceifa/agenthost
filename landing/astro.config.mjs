import { defineConfig } from "astro/config";
import { apexHost } from "../scripts/deploy-config.mjs";

// Static build → landing/dist, copied into public/ and served by the Worker.
export default defineConfig({
  output: "static",
  site: `https://${apexHost()}`,
  build: { format: "file" },
});
