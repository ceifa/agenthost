import type { APIRoute } from "astro";

// Only public marketing pages belong here; hosted sites remain private/noindex.
const paths = ["/"];

export const GET: APIRoute = ({ site }) => {
  const urls = paths.map((path) => `<url><loc>${new URL(path, site).href}</loc></url>`).join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
