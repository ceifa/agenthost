// POST /publish — streaming untar → bounded R2 puts → delete orphans → _meta →
// bump _gen.

import type { Env } from "./env";
import { LIMITS, PUT_CONCURRENCY, DEFAULT_SITE_ID } from "./config";
import {
  generateUsername,
  generateOwnerToken,
  generateAccessKey,
  sanitizeSiteId,
  sha256Hex,
  contentTypeFor,
  siteHost,
  siteUrl,
  shareUrl,
  clientIp,
} from "./ids";
import { verifyOwner } from "./auth";
import { parseTar, TarLimitError } from "./tar";
import { gunzipStream } from "./gunzip";
import {
  putUser,
  getMeta,
  putMeta,
  bumpGen,
  userUsage,
  listAll,
  siteFileKey,
  sitePrefix,
  userKey,
  deleteKeys,
  RESERVED_FILE,
  type SiteMeta,
} from "./storage";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Caps in-flight R2 puts so a wide archive can't spawn hundreds at once.
class PutGate {
  private inFlight = new Set<Promise<unknown>>();
  private firstError: unknown = null;
  constructor(private readonly max: number) {}

  async add(task: () => Promise<unknown>): Promise<void> {
    if (this.firstError) throw this.firstError;
    const p = task()
      .catch((e) => {
        if (!this.firstError) this.firstError = e;
      })
      .finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
    if (this.inFlight.size >= this.max) await Promise.race(this.inFlight);
    if (this.firstError) throw this.firstError;
  }

  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.race(this.inFlight);
    if (this.firstError) throw this.firstError;
  }
}

// Returns a safe relative key, or null to skip the entry.
function safePath(raw: string): string | null {
  let p = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!p) return null;
  // macOS AppleDouble / Finder cruft — never intended web content.
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.startsWith("._") || base === ".DS_Store") return null;
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === "")) return null;
  if (p.includes("\0")) return null;
  return p;
}

// Classify a Content-Type as a single raw document worth serving at `/`, or null
// for archive/binary types (gzip, tar, octet-stream) that take the tar path.
function singleFileKind(contentType: string): "html" | "md" | null {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
  if (ct === "text/markdown" || ct === "text/x-markdown") return "md";
  return null;
}

// A single raw document (a .md or .html piped straight in) instead of the
// default gzipped tar. Triggered by an explicit `?file=` or a lone html/markdown
// Content-Type.
function isSingleFile(contentType: string, url: URL): boolean {
  return url.searchParams.has("file") || singleFileKind(contentType) !== null;
}

// Filename the single document is stored under, so it serves at `/`: an explicit
// `?file=` wins (sanitized), else html → index.html and markdown → README.md.
function singleFileName(contentType: string, url: URL): string | null {
  const explicit = url.searchParams.get("file");
  if (explicit !== null) return safePath(explicit);
  return singleFileKind(contentType) === "html" ? "index.html" : "README.md";
}

// Reads a request body fully into memory, aborting past `max` bytes. Only the
// single-file path uses this (archives stream); the per-file cap keeps it small.
async function readBounded(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new TarLimitError(`file is ${total}+ bytes; max is ${max}`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

interface PublishError {
  status: number;
  message: string;
}
const fail = (status: number, message: string): PublishError => ({ status, message });

export async function handlePublish(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!req.body) return json({ error: "empty body — pipe a gzipped tar or a single file" }, 400);

  // Per-IP throttle before any account minting or R2 work — this is the main
  // lever against anonymous mass-publishing / storage exhaustion.
  if (!(await env.PUBLISH_LIMITER.limit({ key: clientIp(req) })).success) {
    return json({ error: "rate limit exceeded — slow down and retry shortly" }, 429);
  }

  const url = new URL(req.url);
  const apex = env.APEX_HOST;

  let username: string;
  let plan: "free" | "paid" = "free";
  let isNewUser = false;
  let ownerToken: string | undefined;

  if (req.headers.has("authorization")) {
    const owner = await verifyOwner(req, env);
    if (!owner.ok) return json({ error: owner.error }, owner.status);
    username = owner.ctx.username;
    plan = owner.ctx.user.plan;
  } else {
    // Anonymous → always a brand-new account (owned sites require the token).
    do {
      username = generateUsername();
    } while (await env.SITES.head(userKey(username)));
    ownerToken = generateOwnerToken();
    isNewUser = true;
  }

  const siteId = sanitizeSiteId(url.searchParams.get("id") ?? req.headers.get("x-agenthost-site")) ?? DEFAULT_SITE_ID;

  // Fail fast on over-quota: budget = min(per-site cap, account quota minus other sites).
  const limits = LIMITS[plan];
  const [otherUsage, existingMeta] = isNewUser
    ? ([0, null] as const)
    : await Promise.all([userUsage(env.SITES, username, siteId), getMeta(env.SITES, username, siteId)]);
  const totalBudget = Math.min(limits.perSite, Math.max(0, limits.perUser - otherUsage));

  const gate = new PutGate(PUT_CONCURRENCY);
  const writtenKeys = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  let perr: PublishError | null = null;

  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (isSingleFile(contentType, url)) {
      // Single raw document: no archive to stream, so read the body directly and
      // write it under a name that serves at `/`.
      const name = singleFileName(contentType, url);
      if (!name) perr = fail(400, "invalid ?file name");
      else if (RESERVED_FILE(name)) perr = fail(400, `reserved filename: ${name}`);
      else {
        const body = await readBounded(req.body!, limits.perFile);
        if (body.byteLength === 0) perr = fail(400, "empty file");
        else if (body.byteLength > totalBudget)
          perr = fail(413, `site exceeds size budget of ${totalBudget} bytes (plan ${plan})`);
        else {
          totalBytes = body.byteLength;
          fileCount = 1;
          const key = siteFileKey(username, siteId, name);
          writtenKeys.add(key);
          await env.SITES.put(key, body, { httpMetadata: { contentType: contentTypeFor(name) } });
        }
      }
    } else {
      const stream = gunzipStream(req.body!);
      // Hard cap at the per-file limit so an inflated header size can't force the
      // parser to buffer a giant entry before publish's own check runs.
      for await (const entry of parseTar(stream, { maxEntrySize: limits.perFile })) {
        if (entry.type === "symlink" || entry.type === "hardlink") {
          perr = fail(400, `links are not allowed (${entry.path})`);
          break;
        }
        if (entry.type !== "file") continue;

        const path = safePath(entry.path);
        if (path === null) {
          if (entry.path.split("/").some((s) => s === "..")) {
            perr = fail(400, `unsafe path rejected: ${entry.path}`);
            break;
          }
          continue; // silently skipped cruft (._*, .DS_Store, dirs)
        }
        // Never let a user file clobber the per-site control objects.
        if (RESERVED_FILE(path)) continue;

        if (entry.size > limits.perFile) {
          perr = fail(413, `file ${path} is ${entry.size} bytes; max is ${limits.perFile}`);
          break;
        }
        if (fileCount + 1 > limits.filesPerSite) {
          perr = fail(413, `too many files; max is ${limits.filesPerSite}`);
          break;
        }
        if (totalBytes + entry.size > totalBudget) {
          perr = fail(413, `site exceeds size budget of ${totalBudget} bytes (plan ${plan})`);
          break;
        }

        totalBytes += entry.size;
        fileCount += 1;
        const key = siteFileKey(username, siteId, path);
        writtenKeys.add(key);
        const body = entry.body; // per-entry buffer, safe to hold across the put
        await gate.add(() =>
          env.SITES.put(key, body, { httpMetadata: { contentType: contentTypeFor(path) } }),
        );
      }
      await gate.drain();
    }
  } catch (e) {
    if (perr) return json({ error: perr.message }, perr.status);
    if (e instanceof TarLimitError) return json({ error: e.message }, 413);
    const message = e instanceof Error ? e.message : "failed to read archive";
    return json({ error: `bad archive: ${message}` }, 400);
  }

  if (perr) return json({ error: perr.message }, perr.status);
  if (fileCount === 0) return json({ error: "archive contained no files" }, 400);

  // Delete files removed since the last deploy (keep the _gen/_meta control
  // objects). A brand-new username can't have prior objects — skip the list.
  if (!isNewUser) {
    const prefix = sitePrefix(username, siteId);
    const existing = await listAll(env.SITES, prefix);
    const orphans = existing
      .map((o) => o.key)
      .filter((k) => !RESERVED_FILE(k.slice(prefix.length)) && !writtenKeys.has(k));
    await deleteKeys(env.SITES, orphans);
  }

  if (isNewUser) {
    await putUser(env.SITES, username, {
      tokenHash: await sha256Hex(ownerToken!),
      plan: "free",
      createdAt: Date.now(),
    });
  }

  // Mint an access key only on a site's first publish (or if one is missing);
  // redeploys preserve the existing keyHash/public so share links keep working.
  const isPublic = existingMeta?.public ?? false;
  let keyHash = existingMeta?.keyHash ?? "";
  let accessKey: string | undefined;
  if (!keyHash) {
    accessKey = generateAccessKey();
    keyHash = await sha256Hex(accessKey);
  }

  const meta: SiteMeta = {
    createdAt: existingMeta?.createdAt ?? Date.now(),
    lastDeployAt: Date.now(),
    bytes: totalBytes,
    fileCount,
    keyHash,
    public: isPublic,
  };
  await putMeta(env.SITES, username, siteId, meta);

  // Bump generation last: cache invalidation flips only after every byte is in place.
  const generation = await bumpGen(env.SITES, username, siteId);

  const host = siteHost(username, siteId, apex);
  return json({
    url: siteUrl(host),
    shareUrl: shareUrl(host, accessKey),
    username,
    siteId,
    generation,
    fileCount,
    bytes: totalBytes,
    ...(accessKey ? { accessKey } : {}),
    ...(ownerToken ? { ownerToken } : {}),
    ...(isNewUser ? { claimUrl: `https://${apex}/claim?username=${username}` } : {}),
  });
}
