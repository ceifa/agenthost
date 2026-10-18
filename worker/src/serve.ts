// Serve flow for hosted sites:
// (username, siteId from Host) → /_gen live probe | access gate → gen-keyed cache →
// R2 get / markdown render → Share-widget + live-reload injection → noindex.

import type { Env } from "./env";
import { AUTH_COOKIE_PREFIX, IMMUTABLE_CACHE, RENDER_VERSION, LIVE } from "./config";
import { sha256Hex, contentTypeFor, shareUrl } from "./ids";
import { NOINDEX } from "./http";
import { checkAccessKey } from "./access";
import { getMeta, getGen, siteFileKey, isReservedFile, type SiteMeta } from "./storage";
import { renderDoc, homeDoc, loadDocIndexCached, readMarkdownSource, type DocIndex } from "./markdown";
import { interstitialHtml, shareWidget, liveScript, notFoundHtml, goneHtml } from "./templates";

// Internal Cache API hosts. Separate hosts keep published filenames from
// colliding with our own cached data.
const CACHE_HOST = "https://as-cache.internal";
const ROUTE_CACHE_HOST = "https://as-routes.internal";

// noindex on every hosted-site response — only the apex landing is indexable.
function siteHeaders(extra?: Record<string, string>): Headers {
  return new Headers({ ...extra, ...NOINDEX });
}

function etagMatches(header: string | null, etag: string): boolean {
  return header?.split(",").some(t => t.trim() === "*" || t.trim().replace(/^W\//, "") === etag.replace(/^W\//, "")) ?? false;
}

function htmlResponse(body: BodyInit | null, status: number): Response {
  return new Response(body, {
    status,
    headers: siteHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }),
  });
}

interface Decoration {
  shareUrl: string;
  live: string;
  lastDeployAt?: number;
}

// A site is the root of its own subdomain, so both absolute (/css/app.css) and
// relative (./css/app.css) paths resolve correctly with no <base> tweaking — we
// just append the per-request Share widget and the live-reload probe.
function decorate(html: BodyInit | null, d: Decoration, status: number): Response {
  const input = htmlResponse(html, status);
  input.headers.set("cache-control", "private, no-cache");
  const tail = shareWidget(d.shareUrl) + liveScript(d.live, d.lastDeployAt);
  return new HTMLRewriter()
    .on("body", { element: e => void e.append(tail, { html: true }) })
    .transform(input);
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
// version tag reveals nothing the 401/404 pages don't. A migrated site's probe
// costs one R2 read — and usually none, because the answer sits in a
// per-site edge micro-cache for LIVE.genCacheTtlSeconds. Every reader in a colo
// shares that read. Legacy probes may first discover the old layout with an
// extra read. (cache.delete on publish would only clear the publishing
// colo, so detection latency is poll interval + TTL by design.)
async function handleGen(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  username: string,
  siteId: string,
): Promise<Response> {
  const cache = caches.default;
  const cacheReq = new Request(`${CACHE_HOST}/${username}/${siteId}/r${RENDER_VERSION}/_gen`);
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

async function checkAccess(req: Request, env: Env, url: URL, siteId: string, meta: SiteMeta): Promise<{ key: string | null } | Response> {
  if (meta.public || !meta.keyHash) return { key: null };
  const gate = await checkAccessKey(req, url, {
    keyHash: meta.keyHash,
    cookieName: AUTH_COOKIE_PREFIX + siteId,
    cookiePath: "/",
    limiter: env.ACCESS_LIMITER,
    limiterScope: siteId,
  });
  switch (gate.kind) {
    case "granted": return { key: gate.key };
    case "login": return gate.response;
    case "denied": return htmlResponse(interstitialHtml({ siteId, apexHost: env.APEX_HOST, wrong: gate.wrongKey }), gate.status);
  }
}

type TargetKind = "static" | "html" | "md";
interface Target {
  key: string;
  relPath: string;
  kind: TargetKind;
  docIndex?: DocIndex; // pre-fetched by resolveTarget so the md render doesn't re-list
  object?: R2ObjectBody | R2Object; // keep a cold-route GET instead of HEAD + GET
}

function classify(username: string, siteId: string, rel: string): Target {
  const kind: TargetKind = /\.md$/i.test(rel) ? "md" : /\.html?$/i.test(rel) ? "html" : "static";
  return { key: siteFileKey(username, siteId, rel), relPath: rel, kind };
}

// HEAD reads metadata only. A GET may hand R2 the reader's validators and range,
// which only bytes served as published (not a page we render) can honor.
function fetchObject(env: Env, req: Request, key: string, conditional: boolean): Promise<R2ObjectBody | R2Object | null> {
  if (req.method === "HEAD") return env.SITES.head(key);
  return env.SITES.get(key, conditional ? { onlyIf: req.headers, range: req.headers } : undefined);
}

const hasBody = (obj: R2ObjectBody | R2Object | null | undefined): obj is R2ObjectBody => !!obj && "body" in obj;

// A prefetched body we end up not serving still has to be released.
function discard(ctx: ExecutionContext, obj: R2ObjectBody | R2Object | null | undefined) {
  if (hasBody(obj)) ctx.waitUntil(obj.body.cancel());
}

async function resolveTarget(env: Env, ctx: ExecutionContext, req: Request, username: string, siteId: string, rest: string, gen: number): Promise<Target | null> {
  const candidates = rest === "" ? ["index.html"]
    : rest.endsWith("/") ? [rest + "index.html"]
    : [rest, rest + "/index.html"];
  const raw = new URL(req.url).searchParams.has("raw");
  for (const rel of candidates) {
    if (isReservedFile(rel)) continue; // never serve the _gen/_meta control objects
    const target = classify(username, siteId, rel);
    const object = await fetchObject(env, req, target.key, target.kind === "static" || (target.kind === "md" && raw));
    if (object) return { ...target, object };
  }
  // Markdown-only site: `/` renders README.md / first SUMMARY entry.
  if (rest === "") {
    const index = await loadDocIndexCached(env, ctx, username, siteId, gen);
    const home = homeDoc(index);
    if (home) return { ...classify(username, siteId, home), docIndex: index };
  }
  return null;
}

// Resolving a route can cost several HEADs or a whole Markdown listing, even
// when the body is already cached. Cache successful resolutions with the same
// generation as the body. Access metadata is never cached here.
async function resolveTargetCached(
  env: Env,
  ctx: ExecutionContext,
  username: string,
  siteId: string,
  rest: string,
  gen: number,
  req: Request,
): Promise<Target | null> {
  const cache = caches.default;
  const key = new Request(`${ROUTE_CACHE_HOST}/${username}/${siteId}/g${gen}/r${RENDER_VERSION}/${rest}`);
  const hit = await cache.match(key);
  if (hit) return classify(username, siteId, await hit.text());

  const target = await resolveTarget(env, ctx, req, username, siteId, rest, gen);
  if (target) {
    ctx.waitUntil(cache.put(key, new Response(target.relPath, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": IMMUTABLE_CACHE },
    })));
  }
  return target;
}

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

interface Serving {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  host: string;
  meta: SiteMeta;
  gen: number;
  target: Target;
  raw: boolean;
  cacheReq: Request;
  decoration: Decoration;
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
  // The whole path is the file path within the site (siteId rides the host).
  const rest = url.pathname.replace(/^\/+/, "");

  if (rest === "_gen") return handleGen(req, env, ctx, username, siteId);

  const meta = await getMeta(env.SITES, username, siteId);
  if (!meta) return htmlResponse(notFoundHtml(), 404);
  if (meta.tombstone) return htmlResponse(goneHtml(), 410);

  const access = await checkAccess(req, env, url, siteId, meta);
  if (access instanceof Response) return access;
  const gen = meta.generation ?? await getGen(env.SITES, username, siteId);
  const raw = url.searchParams.has("raw");
  const decoration: Decoration = { shareUrl: shareUrl(host, access.key), live: versionTag(gen), lastDeployAt: meta.lastDeployAt };

  const target = await resolveTargetCached(env, ctx, username, siteId, rest, gen, req);
  if (!target) {
    const custom = await env.SITES.get(siteFileKey(username, siteId, "404.html"));
    if (custom) return decorate(req.method === "HEAD" ? null : custom.body, decoration, 404);
    return htmlResponse(notFoundHtml(), 404);
  }

  const serving: Serving = {
    req, env, ctx, host, meta, gen, target, raw, decoration,
    cacheReq: new Request(cacheKeyPath(username, siteId, gen, target, raw)),
  };

  if (target.kind === "md" && !raw) {
    return serveHtml(serving, async () => {
      const obj = target.object ?? await env.SITES.get(target.key);
      if (!hasBody(obj)) return null;
      const source = await readMarkdownSource(obj);
      const index = target.docIndex ?? await loadDocIndexCached(env, ctx, username, siteId, gen);
      return renderDoc(siteId, target.relPath, source, index);
    });
  }

  if (target.kind === "html") {
    return serveHtml(serving, async () => {
      const obj = target.object ?? await env.SITES.get(target.key);
      return hasBody(obj) ? obj.body : null;
    });
  }

  return serveStatic(serving);
}

// Pages get the Share widget and live-reload probe, so the cache holds the
// undecorated body (gen-keyed, no access key) and each request decorates it:
// a rotated key or public toggle takes effect without a redeploy.
async function serveHtml(s: Serving, produce: () => Promise<BodyInit | null>): Promise<Response> {
  const { req, ctx, target, cacheReq } = s;
  // The body also depends on our decoration and the current access policy.
  // Fresh authorization runs before evaluating this validator. No key is
  // stored in a shared cache entry or exposed in an ETag.
  const etag = `W/"${await sha256Hex(JSON.stringify([versionTag(s.gen), target.relPath, s.host, s.meta.public, s.meta.keyHash, s.meta.lastDeployAt]))}"`;
  const matches = (req.method === "GET" || req.method === "HEAD") && etagMatches(req.headers.get("if-none-match"), etag);
  if (matches || req.method === "HEAD") {
    discard(ctx, target.object);
    return new Response(null, {
      status: matches ? 304 : 200,
      headers: siteHeaders({ etag, "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache" }),
    });
  }

  const cache = caches.default;
  let response = await cache.match(cacheReq);
  if (response) discard(ctx, target.object);
  else {
    const produced = await produce();
    if (produced === null) return htmlResponse(notFoundHtml(), 404);
    response = new Response(produced, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": IMMUTABLE_CACHE },
    });
    ctx.waitUntil(cache.put(cacheReq, response.clone()));
  }
  // HTMLRewriter accepts a stream: readers can receive the first bytes before
  // R2/cache finishes producing the page, without allocating a full HTML string.
  const decorated = decorate(response.body, s.decoration, 200);
  decorated.headers.set("etag", etag);
  return decorated;
}

const CONDITIONAL_HEADERS = ["range", "if-none-match", "if-modified-since"] as const;

async function serveStatic(s: Serving): Promise<Response> {
  const { req, env, ctx, target, raw, cacheReq } = s;
  const cache = caches.default;
  const conditional = CONDITIONAL_HEADERS.some(name => req.headers.has(name));

  // Cloudflare's Cache API evaluates validators and byte ranges itself. Pass
  // only these headers; per-reader cookies and keys never enter the cache.
  const cacheHeaders = new Headers();
  for (const name of CONDITIONAL_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) cacheHeaders.set(name, value);
  }
  const hit = await cache.match(new Request(cacheReq, { headers: cacheHeaders }));
  // Older generations may still have entries written before these headers were
  // stored. Let R2 evaluate a condition the legacy cache entry cannot answer.
  const supportsConditions = hit &&
    (!req.headers.has("if-modified-since") || hit.status === 304 || hit.headers.has("last-modified")) &&
    (!req.headers.has("range") || hit.status !== 200 || hit.headers.has("content-length"));
  if (hit && supportsConditions) {
    discard(ctx, target.object);
    if (req.method === "HEAD" && hit.body) ctx.waitUntil(hit.body.cancel());
    const h = new Headers(hit.headers);
    h.set("x-robots-tag", NOINDEX["x-robots-tag"]);
    h.set("cache-control", "no-cache");
    return new Response(req.method === "HEAD" ? null : hit.body, { status: hit.status, headers: h });
  }
  if (hit?.body) ctx.waitUntil(hit.body.cancel());

  const obj = target.object ?? await fetchObject(env, req, target.key, conditional);
  if (!obj) return htmlResponse(notFoundHtml(), 404);

  const h = siteHeaders({ "cache-control": "no-cache" });
  obj.writeHttpMetadata(h);
  if (raw) h.set("content-type", "text/plain; charset=utf-8");
  else if (!h.has("content-type")) h.set("content-type", contentTypeFor(target.relPath));
  h.set("etag", obj.httpEtag);
  h.set("last-modified", obj.uploaded.toUTCString());
  h.set("accept-ranges", "bytes");

  if (req.method === "HEAD") {
    const noneMatch = req.headers.get("if-none-match");
    const modifiedSince = Date.parse(req.headers.get("if-modified-since") ?? "");
    const unchanged = noneMatch !== null ? etagMatches(noneMatch, obj.httpEtag)
      : Number.isFinite(modifiedSince) && Math.floor(obj.uploaded.getTime() / 1000) <= Math.floor(modifiedSince / 1000);
    discard(ctx, obj);
    if (!unchanged) h.set("content-length", String(obj.size));
    return new Response(null, { status: unchanged ? 304 : 200, headers: h });
  }

  // Precondition matched (If-None-Match / If-Modified-Since) → no body present.
  if (!hasBody(obj)) return new Response(null, { status: 304, headers: h });

  let status = 200;
  h.set("content-length", String(obj.size));
  if (obj.range && "offset" in obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    if (length < obj.size) {
      status = 206;
      h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      h.set("content-length", String(length));
    }
  }

  const response = new Response(obj.body, { status, headers: h });
  if (!conditional && status === 200) {
    const stored = new Headers(h);
    stored.set("cache-control", IMMUTABLE_CACHE);
    ctx.waitUntil(cache.put(cacheReq, new Response(response.clone().body, { status: 200, headers: stored })));
  }
  return response;
}
