import { defineConfig } from "astro/config";

// Static build → landing/dist, copied into public/ and served by the Worker.
export default defineConfig({
  output: "static",
  site: "https://agenthost.page",
  build: { format: "file" },
});
