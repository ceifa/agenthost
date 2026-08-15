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
import { peek, isGzip, isTar, isZip, sniffDocKind } from "./sniff";
import {
  putUser,
  getMeta,
  putMeta,
  bumpGen,
  assetUsage,
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

const mime = (contentType: string): string => contentType.split(";")[0]!.trim().toLowerCase();

// Classify a Content-Type as a single raw document worth serving at `/`, or null
// for anything else (archives, binaries, and the useless defaults clients send).
function singleFileKind(contentType: string): "html" | "md" | null {
  const ct = mime(contentType);
  if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
  if (ct === "text/markdown" || ct === "text/x-markdown") return "md";
  return null;
}

// Types that *claim* to be an archive. If the bytes disagree we still take the
// tar path, so the error names the real problem instead of publishing garbage as
// a document. `application/octet-stream` is deliberately absent — it's the
// everything-default, so its body gets sniffed like an unlabelled one.
function claimsArchive(contentType: string): boolean {
  switch (mime(contentType)) {
    case "application/gzip":
    case "application/x-gzip":
    case "application/tar":
    case "application/x-tar":
    case "application/x-gtar":
    case "application/x-compressed-tar":
    case "application/x-tgz":
      return true;
    default:
      return false;
  }
}

// A filename the body carries with it, the standard way. Weaker than `?file=`:
// an uploader may attach it to a tarball, so it only names single documents.
function dispositionFileName(req: Request): string | null {
  const m = req.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!.trim());
  } catch {
    return m[1]!.trim(); // stray % in the name — take it literally
  }
}

// How to read the body. Byte magic outranks the Content-Type header: clients send
// no type, `application/octet-stream`, or curl's `application/x-www-form-urlencoded`
// far more often than the truth, but a gzip header is a gzip header.
type Mode =
  | { kind: "file"; name: string }
  | { kind: "archive"; gzipped: boolean }
  | { kind: "invalid"; message: string };

const named = (raw: string): Mode => {
  const name = safePath(raw);
  return name ? { kind: "file", name } : { kind: "invalid", message: `invalid file name: ${raw}` };
};

function detectMode(req: Request, url: URL, head: Uint8Array): Mode {
  // `?file=` is the caller being explicit — it outranks everything, including the
  // bytes, so a tarball can still be published as one downloadable file.
  const explicit = url.searchParams.get("file");
  if (explicit !== null) return named(explicit);

  if (isGzip(head)) return { kind: "archive", gzipped: true };
  if (isTar(head)) return { kind: "archive", gzipped: false };

  const contentType = req.headers.get("content-type") ?? "";
  if (claimsArchive(contentType)) return { kind: "archive", gzipped: true };

  if (isZip(head)) {
    return { kind: "invalid", message: "zip is not supported — send a gzipped tar (tar czf - -C ./dist .)" };
  }

  // Not an archive, so it's one document: prefer the name it came with, since the
  // extension is a better signal than anything we can infer.
  const filename = dispositionFileName(req);
  if (filename !== null) return named(filename);

  // Header next (it's an explicit claim), then the bytes themselves: front
  // matter → markdown, a doctype/html tag → html, prose → markdown.
  const kind = singleFileKind(contentType) ?? sniffDocKind(head);
  if (kind === null) {
    return {
      kind: "invalid",
      message: "unrecognized body — send a gzipped tar, a .md/.html document, or name it with ?file=<name>",
    };
  }
  // Named so it serves at `/`: html as-is, markdown as the docs home.
  return { kind: "file", name: kind === "html" ? "index.html" : "README.md" };
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
    : await Promise.all([
        Promise.all([userUsage(env.SITES, username, siteId), assetUsage(env.SITES, username)]).then(
          ([siteBytes, assetBytes]) => siteBytes + assetBytes,
        ),
        getMeta(env.SITES, username, siteId),
      ]);
  const totalBudget = Math.min(limits.perSite, Math.max(0, limits.perUser - otherUsage));

  const gate = new PutGate(PUT_CONCURRENCY);
  const writtenKeys = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  let perr: PublishError | null = null;

  // Peek before branching: the payload's own bytes decide archive-vs-document,
  // with the Content-Type header as a fallback rather than the source of truth.
  const { head, stream: body } = await peek(req.body!);
  const mode = detectMode(req, url, head);
  if (mode.kind === "invalid") return json({ error: mode.message }, 400);

  try {
    if (mode.kind === "file") {
      // Single raw document: no archive to stream, so read the body directly and
      // write it under a name that serves at `/`.
      const name = mode.name;
      if (RESERVED_FILE(name)) perr = fail(400, `reserved filename: ${name}`);
      else {
        const bytes = await readBounded(body, limits.perFile);
        if (bytes.byteLength === 0) perr = fail(400, "empty file");
        else if (bytes.byteLength > totalBudget)
          perr = fail(413, `site exceeds size budget of ${totalBudget} bytes (plan ${plan})`);
        else {
          totalBytes = bytes.byteLength;
          fileCount = 1;
          const key = siteFileKey(username, siteId, name);
          writtenKeys.add(key);
          await env.SITES.put(key, bytes, { httpMetadata: { contentType: contentTypeFor(name) } });
        }
      }
    } else {
      // Bare tars are accepted too — only gzipped bodies go through the inflater.
      const stream = mode.gzipped ? gunzipStream(body) : body;
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
