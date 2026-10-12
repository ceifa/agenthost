// The apex host for build-time config (landing site URL, dev proxies). It is
// read from vars.APEX_HOST in worker/wrangler.jsonc, so the domain is set in one
// place; an APEX_HOST environment variable overrides it.
import { readFileSync } from "node:fs";

const wranglerConfig = new URL("../worker/wrangler.jsonc", import.meta.url);

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
  return process.env.APEX_HOST || readWranglerConfig().vars.APEX_HOST;
}
