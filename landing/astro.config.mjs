import { defineConfig } from "astro/config";
import { abuseEmail, apexHost } from "../scripts/deploy-config.mjs";

// Static build → landing/dist, copied into public/ and served by the Worker.
export default defineConfig({
  output: "static",
  site: `https://${apexHost()}`,
  build: { format: "file" },
  // Read here, not in the page: the page is bundled, and deploy-config.mjs finds
  // its files relative to itself.
  vite: { define: { __ABUSE_EMAIL__: JSON.stringify(abuseEmail()) } },
});
