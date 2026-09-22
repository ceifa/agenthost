// Serve flow for hosted sites:
// (username, siteId from Host) → /_gen live probe | access gate → gen-keyed cache →
// R2 get / markdown render → Share-widget + live-reload injection → noindex.

import type { Env } from "./env";
import { AUTH_COOKIE_PREFIX, AUTH_COOKIE_MAX_AGE, RENDER_VERSION, LIVE } from "./config";
import { sha256Hex, timingSafeEqual, contentTypeFor, shareUrl, clientIp } from "./ids";
import { getMeta, getGen, siteFileKey, RESERVED_FILE, type SiteMeta } from "./storage";
import { renderMarkdown, defaultMarkdownDoc, type DocIndex } from "./markdown";
import { interstitialHtml, shareWidget, liveScript, notFoundHtml, goneHtml } from "./templates";

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// noindex on every hosted-site response — only the apex landing is indexable.
function siteHeaders(extra?: Record<string, string>): Headers {
  const h = new Headers(extra);
  h.set("x-robots-tag", "noindex, nofollow");
  return h;
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: siteHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }),
  });
}

// A site is now the root of its own subdomain, so both absolute (/css/app.css)
// and relative (./css/app.css) paths resolve correctly with no <base> tweaking —
// we just append the per-request Share widget and the live-reload probe.
function decorate(html: string, opts: { shareUrl: string | null; live: string }, status: number): Response {
  const input = htmlResponse(html, status);
  const tail = (opts.shareUrl ? shareWidget(opts.shareUrl) : "") + liveScript(opts.live);
  const rw = new HTMLRewriter().on("body", {
    element(e) {
      e.append(tail, { html: true });
    },
  });
  return rw.transform(input);
}

// What a reader's page compares against /_gen. Both halves matter: a site publish
// bumps the generation; a Worker deploy that changes what we render bumps
// RENDER_VERSION, and readers of a site that never republishes should see that too.
export function versionTag(gen: number): string {
  return `g${gen}-r${RENDER_VERSION}`;
}

// The /_gen body, with ETag/304 so a steady-state poll moves almost no bytes.
// no-store on the client side: the poll interval is the page's to control.
export function genResponse(version: string, ifNoneMatch: string | null): Response {
  const etag = `"${version}"`;
  const h = siteHeaders({ etag, "cache-control": "no-store" });
  const matches = ifNoneMatch?.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`) ?? false;
  if (matches) return new Response(null, { status: 304, headers: h });
  h.set("content-type", "text/plain; charset=utf-8");
  return new Response(version, { status: 200, headers: h });
}

// Live-reload probe. Deliberately public and answered before the access gate: a
// version tag reveals nothing the 401/404 pages don't, and skipping _meta means a
// poll costs at most one R2 read — and usually none, because the answer sits in a
// per-site edge micro-cache for LIVE.genCacheTtlSeconds. Every reader in a colo
// shares that one read. (cache.delete on publish would only clear the publishing
// colo, so detection latency is poll interval + TTL by design.)
async function handleGen(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  username: string,
  siteId: string,
): Promise<Response> {
  const cache = caches.default;
  const cacheReq = new Request(`${CACHE_HOST}/${username}/${siteId}/_gen`);
  let hit = await cache.match(cacheReq);
  if (!hit) {
    const gen = await getGen(env.SITES, username, siteId);
    hit = new Response(versionTag(gen), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": `public, s-maxage=${LIVE.genCacheTtlSeconds}` },
    });
    ctx.waitUntil(cache.put(cacheReq, hit.clone()));
  }
  return genResponse(await hit.text(), req.headers.get("if-none-match"));
}

interface AccessResult {
  response?: Response; // interstitial or 302 (short-circuits serving)
  key: string | null; // raw access key known at serve time (null = public)
}

// Private-by-default gate: a matching ?k logs the visitor in via cookie, then
// redirects to drop the key from the URL; a bare visit gets the password prompt.
async function checkAccess(req: Request, env: Env, url: URL, siteId: string, meta: SiteMeta): Promise<AccessResult> {
  if (meta.public || !meta.keyHash) return { key: null };
  const keyHash = meta.keyHash;
  const cookieName = AUTH_COOKIE_PREFIX + siteId;

  const cookieKey = getCookie(req, cookieName);
  if (cookieKey && timingSafeEqual(await sha256Hex(cookieKey), keyHash)) {
    return { key: cookieKey };
  }

  const k = url.searchParams.get("k");
  if (k) {
    if (timingSafeEqual(await sha256Hex(k), keyHash)) {
      const clean = new URL(url);
      clean.searchParams.delete("k");
      const res = new Response(null, {
        status: 302,
        headers: siteHeaders({ location: clean.pathname + clean.search }),
      });
      res.headers.append(
        "set-cookie",
        `${cookieName}=${k}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`,
      );
      return { response: res, key: k };
    }
    // Wrong key: throttle guessing per IP+site before re-prompting. (The keyspace
    // already makes brute force infeasible; this also caps the invocation cost.)
    const status = (await env.ACCESS_LIMITER.limit({ key: `${clientIp(req)}:${siteId}` })).success ? 401 : 429;
    return { response: htmlResponse(interstitialHtml({ siteId, apexHost: env.APEX_HOST, wrong: true }), status), key: null };
  }

  return { response: htmlResponse(interstitialHtml({ siteId, apexHost: env.APEX_HOST }), 401), key: null };
}

type TargetKind = "static" | "html" | "md";
interface Target {
  key: string;
  relPath: string;
  kind: TargetKind;
  docIndex?: DocIndex; // pre-fetched by resolveTarget so the md render doesn't re-list
}

function classify(username: string, siteId: string, rel: string): Target {
  const kind: TargetKind = /\.md$/i.test(rel) ? "md" : /\.html?$/i.test(rel) ? "html" : "static";
  return { key: siteFileKey(username, siteId, rel), relPath: rel, kind };
}

async function resolveTarget(env: Env, username: string, siteId: string, rest: string): Promise<Target | null> {
  const candidates: string[] = [];
  if (rest === "") candidates.push("index.html");
  else if (rest.endsWith("/")) candidates.push(rest + "index.html");
  else {
    candidates.push(rest);
    candidates.push(rest + "/index.html");
  }
  for (const rel of candidates) {
    if (RESERVED_FILE(rel)) continue; // never serve the _gen/_meta control objects
    if (await env.SITES.head(siteFileKey(username, siteId, rel))) return classify(username, siteId, rel);
  }
  // Markdown-only site: `/` renders README.md / first SUMMARY entry.
  if (rest === "") {
    const md = await defaultMarkdownDoc(env, username, siteId);
    if (md) return { ...classify(username, siteId, md.path), docIndex: md.index };
  }
  return null;
}

const CACHE_HOST = "https://as-cache.internal";
// Gen-keyed cache entries can be immutable: a deploy bumps the gen, which mints a
// fresh cache key and orphans the old entry. Clients always get no-cache (above).
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Static bytes are the file the site published, so the generation alone pins them.
// A rendered markdown page is *our* HTML, so it also depends on the renderer that
// produced it — RENDER_VERSION puts that in the key, which is what lets a Worker
// deploy reach sites that never republish.
export function cacheKeyPath(
  username: string,
  siteId: string,
  gen: number,
  target: { kind: TargetKind; relPath: string },
  raw: boolean,
): string {
  const rendered = target.kind === "md" && !raw;
  const version = rendered ? `/r${RENDER_VERSION}` : "";
  return `${CACHE_HOST}/${username}/${siteId}/g${gen}${version}/${target.relPath}${raw ? "?raw" : ""}`;
}

export async function handleSite(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  username: string,
  siteId: string,
  host: string,
): Promise<Response> {
  const url = new URL(req.url);
  if (!siteId) return htmlResponse(notFoundHtml(), 404);
  // The whole path is now the file path within the site (siteId rides the host).
  const rest = url.pathname.replace(/^\/+/, "");

  if (rest === "_gen") return handleGen(req, env, ctx, username, siteId);

  // Independent reads — fetch together.
  const [meta, gen] = await Promise.all([getMeta(env.SITES, username, siteId), getGen(env.SITES, username, siteId)]);
  if (!meta) return htmlResponse(notFoundHtml(), 404);
  if (meta.tombstone) return htmlResponse(goneHtml(), 410);

  const gate = await checkAccess(req, env, url, siteId, meta);
  if (gate.response) return gate.response;

  const raw = url.searchParams.has("raw");
  const share = shareUrl(host, gate.key);
  const live = versionTag(gen);

  const target = await resolveTarget(env, username, siteId, rest);
  if (!target) {
    const custom = await env.SITES.get(siteFileKey(username, siteId, "404.html"));
    if (custom) return decorate(await custom.text(), { shareUrl: share, live }, 404);
    return htmlResponse(notFoundHtml(), 404);
  }

  const cache = caches.default;
  const cacheReq = new Request(cacheKeyPath(username, siteId, gen, target, raw));

  // Cache the undecorated body (gen-keyed, no access key); inject the Share
  // widget per request so a rotated key or public toggle takes effect without a
  // redeploy.
  const serveHtmlCached = async (produce: () => Promise<string | null>): Promise<Response> => {
    const hit = await cache.match(cacheReq);
    let body: string;
    if (hit) {
      body = await hit.text();
    } else {
      const produced = await produce();
      if (produced === null) return htmlResponse(notFoundHtml(), 404);
      body = produced;
      ctx.waitUntil(
        cache.put(cacheReq, new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": IMMUTABLE_CACHE } })),
      );
    }
    return decorate(body, { shareUrl: share, live }, 200);
  };

  if (target.kind === "md" && !raw) {
    return serveHtmlCached(async () => {
      const obj = await env.SITES.get(target.key);
      return obj ? renderMarkdown(env, username, siteId, target.relPath, await obj.text(), target.docIndex) : null;
    });
  }

  if (target.kind === "html") {
    return serveHtmlCached(async () => {
      const obj = await env.SITES.get(target.key);
      return obj ? obj.text() : null;
    });
  }

  // ── static assets (incl. ?raw markdown): stream bytes, native 304/206 ──
  const conditional = req.headers.has("range") || req.headers.has("if-none-match") || req.headers.has("if-modified-since");

  if (!conditional) {
    const hit = await cache.match(cacheReq);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("x-robots-tag", "noindex, nofollow");
      h.set("cache-control", "no-cache");
      return new Response(hit.body, { status: hit.status, headers: h });
    }
  }

  const obj = await env.SITES.get(target.key, conditional ? { onlyIf: req.headers, range: req.headers } : undefined);
  if (!obj) return htmlResponse(notFoundHtml(), 404);

  const h = siteHeaders({ "cache-control": "no-cache" });
  obj.writeHttpMetadata(h);
  if (raw) h.set("content-type", "text/plain; charset=utf-8");
  else if (!h.has("content-type")) h.set("content-type", contentTypeFor(target.relPath));
  h.set("etag", obj.httpEtag);

  // Precondition matched (If-None-Match / If-Modified-Since) → no body present.
  if (!("body" in obj)) return new Response(null, { status: 304, headers: h });

  const bodyObj = obj as R2ObjectBody;
  let status = 200;
  if (bodyObj.range && "offset" in bodyObj.range) {
    const offset = bodyObj.range.offset ?? 0;
    const length = bodyObj.range.length ?? bodyObj.size - offset;
    if (length < bodyObj.size) {
      status = 206;
      h.set("content-range", `bytes ${offset}-${offset + length - 1}/${bodyObj.size}`);
      h.set("content-length", String(length));
    }
  }
  h.set("accept-ranges", "bytes");

  const response = new Response(bodyObj.body, { status, headers: h });
  if (!conditional && status === 200) {
    const cacheHeaders = new Headers(h);
    cacheHeaders.set("cache-control", IMMUTABLE_CACHE);
    ctx.waitUntil(cache.put(cacheReq, new Response(response.clone().body, { status: 200, headers: cacheHeaders })));
  }
  return response;
}
