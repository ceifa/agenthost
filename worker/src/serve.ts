// Serve flow for shares:
// (username, siteId from Host) → /_gen live probe | access gate → gen-keyed cache →
// R2 get / markdown render / file index → Share-widget + live-reload injection → noindex.

import type { Env } from "./env";
import { AUTH_COOKIE_PREFIX, CACHE_MAX_BYTES, RENDER_VERSION, LIVE } from "./config";
import { sha256Hex, contentTypeFor, encodePath, shareUrl } from "./ids";
import { checkAccessKey } from "./auth";
import { committedFiles, getMeta, listAll, siteFileKey, sitePrefix, visitKey } from "./storage";
import { renderDoc, homeDoc, loadDocIndexCached, readMarkdownSource, type DocIndex } from "./markdown";
import { shareWidget, liveScript, notFoundHtml, goneHtml, fileIndexHtml } from "./templates";

// noindex on every hosted-site response — only the apex landing is indexable.
function siteHeaders(extra?: Record<string, string>): Headers {
  const h = new Headers(extra);
  h.set("x-robots-tag", "noindex, nofollow");
  return h;
}

export function attachmentDisposition(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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

// A site is now the root of its own subdomain, so both absolute (/css/app.css)
// and relative (./css/app.css) paths resolve correctly with no <base> tweaking —
// we just append the per-request Share widget and the live-reload probe.
function decorate(html: BodyInit | null, opts: { shareUrl: string | null; live: string; lastDeployAt?: number }, status: number): Response {
  const input = htmlResponse(html, status);
  input.headers.set("cache-control", "private, no-cache");
  const tail = (opts.shareUrl ? shareWidget(opts.shareUrl) : "") + liveScript(opts.live, opts.lastDeployAt);
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
// version tag reveals nothing the 401/404 pages don't. A probe costs one R2
// read — and usually none, because the answer sits in a per-site edge
// micro-cache for LIVE.genCacheTtlSeconds. Every reader in a colo shares that
// read. (cache.delete on publish would only clear the publishing colo, so
// detection latency is poll interval + TTL by design.)
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
    const gen = (await getMeta(env.SITES, username, siteId))?.generation ?? 0;
    hit = new Response(versionTag(gen), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": `public, s-maxage=${LIVE.genCacheTtlSeconds}` },
    });
    ctx.waitUntil(cache.put(cacheReq, hit.clone()));
  }
  return genResponse(await hit.text(), req.headers.get("if-none-match"));
}

// "index" is the share's root when it has no page of its own.
type TargetKind = "static" | "html" | "md" | "index";
interface Target {
  key: string;
  relPath: string;
  kind: TargetKind;
  docIndex?: DocIndex; // pre-fetched by resolveTarget so the md render doesn't re-list
  object?: R2ObjectBody | R2Object; // keep a cold-route GET instead of HEAD + GET
}

function classify(username: string, siteId: string, rel: string): Target {
  const kind: TargetKind = rel === "" ? "index" : /\.md$/i.test(rel) ? "md" : /\.html?$/i.test(rel) ? "html" : "static";
  return { key: siteFileKey(username, siteId, rel), relPath: rel, kind };
}

async function resolveTarget(env: Env, ctx: ExecutionContext, req: Request, username: string, siteId: string, rest: string, gen: number, asFile: boolean): Promise<Target | null> {
  const candidates: string[] = [];
  if (rest === "") candidates.push("index.html");
  else if (rest.endsWith("/")) candidates.push(rest + "index.html");
  else {
    candidates.push(rest);
    candidates.push(rest + "/index.html");
  }
  for (const rel of candidates) {
    const target = classify(username, siteId, rel);
    const conditional = target.kind === "static" || asFile;
    const object = req.method === "HEAD"
      ? await env.SITES.head(target.key)
      : await env.SITES.get(target.key, conditional ? { onlyIf: req.headers, range: req.headers } : undefined);
    if (object) return { ...target, object };
  }
  // Markdown-only site: `/` renders README.md / first SUMMARY entry; with no
  // Markdown either, it lists the files.
  if (rest === "") {
    const index = await loadDocIndexCached(env, ctx, username, siteId, gen);
    const home = homeDoc(index);
    return home ? { ...classify(username, siteId, home), docIndex: index } : classify(username, siteId, "");
  }
  return null;
}

const CACHE_HOST = "https://as-cache.internal";
// Gen-keyed cache entries can be immutable: a deploy bumps the gen, which mints a
// fresh cache key and orphans the old entry. Clients always get no-cache (above).
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Resolving a route can cost several HEADs or a whole Markdown listing, even
// when the body is already cached. Cache successful resolutions with the same
// generation as the body. Keep them on a separate host so published filenames
// cannot collide with this internal data. Access metadata is never cached here.
async function resolveTargetCached(
  env: Env,
  ctx: ExecutionContext,
  username: string,
  siteId: string,
  rest: string,
  gen: number,
  req: Request,
  asFile: boolean,
): Promise<Target | null> {
  const cache = caches.default;
  const key = new Request(`https://as-routes.internal/${username}/${siteId}/g${gen}/r${RENDER_VERSION}/${encodePath(rest)}`);
  const hit = await cache.match(key);
  if (hit) return classify(username, siteId, await hit.text());

  const target = await resolveTarget(env, ctx, req, username, siteId, rest, gen, asFile);
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
  const rendered = target.kind === "index" || (target.kind === "md" && !raw);
  const version = rendered ? `/r${RENDER_VERSION}` : "";
  return `${CACHE_HOST}/${username}/${siteId}/g${gen}${version}/${encodePath(target.relPath)}${raw ? "?raw" : ""}`;
}

// Retention counts from the last visit, so a reader opening a share keeps it.
// One R2 write per share per day per colo: an isolate remembers what it already
// recorded, and a day-keyed Cache API marker covers the other isolates in a colo.
const DAY_MS = 24 * 60 * 60 * 1000;
const visited = new Set<string>();

function recordVisit(env: Env, ctx: ExecutionContext, username: string, siteId: string): void {
  const day = Math.floor(Date.now() / DAY_MS);
  const id = `${day}/${username}/${siteId}`;
  if (visited.has(id)) return;
  if (visited.size > 10_000) visited.clear();
  visited.add(id);
  ctx.waitUntil((async () => {
    const marker = new Request(`https://as-visits.internal/${id}`);
    if (await caches.default.match(marker)) return;
    await env.SITES.put(visitKey(username, siteId), "");
    await caches.default.put(marker, new Response(null, { headers: { "cache-control": `public, s-maxage=${DAY_MS / 1000}` } }));
  })().catch(() => visited.delete(id)));
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
  // The whole path is the file path within the share (siteId rides the host).
  // Files are stored under their decoded names; links to them are percent-encoded.
  let rest: string;
  try {
    rest = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return htmlResponse(notFoundHtml(), 404);
  }

  if (rest === "_gen") return handleGen(req, env, ctx, username, siteId);

  const meta = await getMeta(env.SITES, username, siteId);
  if (!meta) return htmlResponse(notFoundHtml(), 404);
  if (meta.tombstone) return htmlResponse(goneHtml(), 410);

  let key: string | null = null;
  if (!meta.public && (meta.accessKey || meta.keyHash)) {
    const gate = await checkAccessKey(req, env, {
      accessKey: meta.accessKey, keyHash: meta.keyHash, label: siteId, cookieName: AUTH_COOKIE_PREFIX + siteId, limiterKey: siteId,
    });
    if (gate instanceof Response) return gate;
    key = gate;
  }
  const gen = meta.generation;

  const raw = url.searchParams.has("raw");
  // ?download hands over the file itself, never our rendering of it.
  const download = url.searchParams.has("download");
  const asFile = raw || download;
  const share = shareUrl(host, key);
  const live = versionTag(gen);

  const target = await resolveTargetCached(env, ctx, username, siteId, rest, gen, req, asFile);
  if (!target) {
    const custom = await env.SITES.get(siteFileKey(username, siteId, "404.html"));
    if (custom) return decorate(req.method === "HEAD" ? null : custom.body, { shareUrl: share, live, lastDeployAt: meta.lastDeployAt }, 404);
    return htmlResponse(notFoundHtml(), 404);
  }

  recordVisit(env, ctx, username, siteId);

  const cache = caches.default;
  const cacheReq = new Request(cacheKeyPath(username, siteId, gen, target, asFile));
  const cancelPrefetch = () => {
    if (target.object && "body" in target.object) ctx.waitUntil(target.object.body.cancel());
  };

  // Cache the undecorated body (gen-keyed, no access key); inject the Share
  // widget per request so a rotated key or public toggle takes effect without a
  // redeploy.
  const serveHtmlCached = async (produce: () => Promise<BodyInit | null>): Promise<Response> => {
    // The body also depends on our decoration and the current access policy.
    // Fresh authorization runs before evaluating this validator. No key is
    // stored in a shared cache entry or exposed in an ETag.
    const etag = `W/"${await sha256Hex(JSON.stringify([versionTag(gen), target.relPath, host, meta.public, meta.accessKey ?? meta.keyHash, meta.lastDeployAt]))}"`;
    const matches = (req.method === "GET" || req.method === "HEAD") && etagMatches(req.headers.get("if-none-match"), etag);
    if (matches || req.method === "HEAD") {
      cancelPrefetch();
      return new Response(null, { status: matches ? 304 : 200, headers: siteHeaders({ etag, "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache" }) });
    }
    let response = await cache.match(cacheReq);
    if (response) cancelPrefetch();
    if (!response) {
      const produced = await produce();
      if (produced === null) return htmlResponse(notFoundHtml(), 404);
      response = new Response(produced, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": IMMUTABLE_CACHE },
      });
      ctx.waitUntil(cache.put(cacheReq, response.clone()));
    }
    // HTMLRewriter accepts a stream: readers can receive the first bytes before
    // R2/cache finishes producing the page, without allocating a full HTML string.
    const decorated = decorate(response.body, { shareUrl: share, live, lastDeployAt: meta.lastDeployAt }, 200);
    decorated.headers.set("etag", etag);
    return decorated;
  };

  if (target.kind === "index") {
    return serveHtmlCached(async () => {
      const prefix = sitePrefix(username, siteId);
      const files = committedFiles(await listAll(env.SITES, prefix), username, siteId, meta).map(o => {
        const path = o.key.slice(prefix.length);
        return { path, bytes: o.size, contentType: contentTypeFor(path) };
      });
      return fileIndexHtml({ siteId, files });
    });
  }

  if (target.kind === "md" && !asFile) {
    return serveHtmlCached(async () => {
      const obj = target.object ?? await env.SITES.get(target.key);
      if (!obj || !("body" in obj)) return null;
      const source = await readMarkdownSource(obj as R2ObjectBody);
      const index = target.docIndex ?? await loadDocIndexCached(env, ctx, username, siteId, gen);
      return renderDoc(siteId, target.relPath, source, index);
    });
  }

  if (target.kind === "html" && !download) {
    return serveHtmlCached(async () => {
      const obj = target.object ?? await env.SITES.get(target.key);
      return obj && "body" in obj ? (obj as R2ObjectBody).body : null;
    });
  }

  // ── static assets (incl. ?raw markdown): stream bytes, native 304/206 ──
  const conditional = req.headers.has("range") || req.headers.has("if-none-match") || req.headers.has("if-modified-since");

  // Cloudflare's Cache API evaluates validators and byte ranges itself. Pass
  // only these headers; per-reader cookies and keys never enter the cache.
  const cacheHeaders = new Headers();
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = req.headers.get(name);
    if (value !== null) cacheHeaders.set(name, value);
  }
  const hit = await cache.match(new Request(cacheReq, { headers: cacheHeaders }));
  // Older generations may still have entries written before these headers were
  // stored. Let R2 evaluate a condition the legacy cache entry cannot answer.
  const supportsConditions = hit &&
    (!req.headers.has("if-modified-since") || hit.status === 304 || hit.headers.has("last-modified")) &&
    (!req.headers.has("range") || hit.status !== 200 || hit.headers.has("content-length"));
  // Per-request presentation, applied after the cache so one entry serves all.
  const present = (h: Headers) => {
    h.set("x-robots-tag", "noindex, nofollow");
    h.set("cache-control", "no-cache");
    if (raw) h.set("content-type", "text/plain; charset=utf-8");
    if (download) h.set("content-disposition", attachmentDisposition(target.relPath.slice(target.relPath.lastIndexOf("/") + 1)));
    return h;
  };
  if (hit && supportsConditions) {
    cancelPrefetch();
    if (req.method === "HEAD" && hit.body) ctx.waitUntil(hit.body.cancel());
    return new Response(req.method === "HEAD" ? null : hit.body, { status: hit.status, headers: present(new Headers(hit.headers)) });
  }
  if (hit?.body) ctx.waitUntil(hit.body.cancel());

  const obj = target.object ?? (req.method === "HEAD" ? await env.SITES.head(target.key) : await env.SITES.get(target.key, conditional ? { onlyIf: req.headers, range: req.headers } : undefined));
  if (!obj) return htmlResponse(notFoundHtml(), 404);

  const h = new Headers();
  obj.writeHttpMetadata(h);
  // A direct upload stores a type only when the caller forced one.
  const stored = h.get("content-type");
  if (!stored || stored === "application/octet-stream") h.set("content-type", contentTypeFor(target.relPath));
  h.set("etag", obj.httpEtag);
  h.set("last-modified", obj.uploaded.toUTCString());

  if (req.method === "HEAD") {
    const noneMatch = req.headers.get("if-none-match");
    const modifiedSince = Date.parse(req.headers.get("if-modified-since") ?? "");
    const unchanged = noneMatch !== null ? etagMatches(noneMatch, obj.httpEtag)
      : Number.isFinite(modifiedSince) && Math.floor(obj.uploaded.getTime() / 1000) <= Math.floor(modifiedSince / 1000);
    cancelPrefetch();
    if ("body" in obj && obj !== target.object) ctx.waitUntil((obj as R2ObjectBody).body.cancel());
    if (!unchanged) h.set("content-length", String(obj.size));
    h.set("accept-ranges", "bytes");
    return new Response(null, { status: unchanged ? 304 : 200, headers: present(h) });
  }

  // Precondition matched (If-None-Match / If-Modified-Since) → no body present.
  if (!("body" in obj)) return new Response(null, { status: 304, headers: present(h) });

  const bodyObj = obj as R2ObjectBody;
  let status = 200;
  h.set("content-length", String(bodyObj.size));
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

  if (!conditional && status === 200 && bodyObj.size <= CACHE_MAX_BYTES) {
    const [served, stored] = bodyObj.body.tee();
    const cacheHeaders = new Headers(h);
    cacheHeaders.set("cache-control", IMMUTABLE_CACHE);
    ctx.waitUntil(cache.put(cacheReq, new Response(stored, { status: 200, headers: cacheHeaders })));
    return new Response(served, { status, headers: present(h) });
  }
  return new Response(bodyObj.body, { status, headers: present(h) });
}
