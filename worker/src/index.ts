// Worker entry — routes by Host:
//   admin.agenthost.page            → admin (behind Cloudflare Access; JWT-verified)
//   agenthost.page / www            → apex: landing (Static Assets) + /publish + owner API
//   {username}-{siteId}.agenthost.page → hosted site (split on the first hyphen)
//   any other host                   → custom domain → _domains lookup → hosted site
// Plus a nightly scheduled() retention sweep.

import type { Env } from "./env";
import { apexApp } from "./apex";
import { handleAdmin } from "./admin";
import { handleSite } from "./serve";
import { getDomain, type DomainRecord } from "./storage";
import { runRetentionSweep } from "./sweep";

function resolveHost(req: Request, env: Env, url: URL): string {
  const override = env.DEV_MODE === "1" ? url.searchParams.get("__host") : null;
  const raw = override ?? req.headers.get("host") ?? url.host;
  const host = raw.toLowerCase().split(":")[0]!;
  // In local dev, treat a bare localhost as the apex so the control plane is
  // reachable without an override; a ?__host= override still wins (handled above).
  if (env.DEV_MODE === "1" && !override && (host === "localhost" || host === "127.0.0.1")) {
    return env.APEX_HOST.toLowerCase();
  }
  return host;
}

// Custom-domain mappings change rarely but are checked on every request for a
// mapped host — a short per-isolate cache keeps R2 off that hot path.
const DOMAIN_CACHE_TTL_MS = 60_000;
const domainCache = new Map<string, { rec: DomainRecord | null; expires: number }>();

async function lookupDomain(env: Env, host: string): Promise<DomainRecord | null> {
  const hit = domainCache.get(host);
  if (hit && hit.expires > Date.now()) return hit.rec;
  const rec = await getDomain(env.SITES, host);
  domainCache.set(host, { rec, expires: Date.now() + DOMAIN_CACHE_TTL_MS });
  return rec;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = resolveHost(req, env, url);
    const apex = env.APEX_HOST.toLowerCase();

    if (host === `admin.${apex}`) return handleAdmin(req, env);

    // Control-plane endpoints; unmatched paths fall through to the landing page
    // via the app's notFound handler. (resolveHost maps bare localhost → apex in
    // dev, so no separate dev-host case is needed here.)
    if (host === apex || host === `www.${apex}`) return apexApp.fetch(req, env, ctx);

    if (host.endsWith(`.${apex}`)) {
      // {username}-{siteId}.{apex} → split on the first hyphen (usernames are
      // hyphen-free, so everything after it is the siteId).
      const sub = host.slice(0, host.length - apex.length - 1);
      const dash = sub.indexOf("-");
      if (dash <= 0 || dash === sub.length - 1) return new Response("not found", { status: 404 });
      const username = sub.slice(0, dash);
      const siteId = sub.slice(dash + 1);
      return handleSite(req, env, ctx, username, siteId, host);
    }

    // Custom domain → serve its mapped site (siteId no longer rides the path).
    const dom = await lookupDomain(env, host);
    if (dom) {
      return handleSite(req, env, ctx, dom.username, dom.siteId, host);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runRetentionSweep(env, Date.now()).then((r) => console.log("retention sweep:", JSON.stringify(r))),
    );
  },
} satisfies ExportedHandler<Env>;
