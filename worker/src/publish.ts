// PUT /shares/{id} — streaming files → bounded R2 puts → delete orphans (unless
// merging) → commit generation and access metadata together.

import type { Env } from "./env";
import { LIMITS, MAX_BUFFERED_BYTES, MAX_FILE_BYTES, MAX_FILES, PUT_CONCURRENCY } from "./config";
import {
  generateUsername,
  generateOwnerToken,
  generateAccessKey,
  sanitizeSiteId,
  sha256Hex,
  contentTypeFor,
  siteHost,
  metaUrl,
  clientIp,
} from "./ids";
import { verifyOwner } from "./auth";
import { parseTar, TarLimitError, type TarEntry } from "./tar";
import { gunzipStream } from "./gunzip";
import { peek, isGzip, isTar, isZip, sniffDocKind } from "./sniff";
import {
  putUser,
  getMeta,
  putMeta,
  reconcileUploads,
  userUsage,
  listAll,
  committedFiles,
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

// Streams one tar entry into R2 without buffering it. `read` settles once the
// entry's bytes are all consumed, and only then may the parser advance; `stored`
// settles when R2 has the object.
function streamEntry(
  bucket: R2Bucket,
  key: string,
  entry: TarEntry,
  contentType: string,
): { read: Promise<void>; stored: Promise<unknown> } {
  const opts = { httpMetadata: { contentType } };
  if (entry.size === 0) return { read: Promise.resolve(), stored: bucket.put(key, new Uint8Array(0), opts) };
  // R2 needs the length up front; FixedLengthStream carries it and rejects a mismatch.
  const { readable, writable } = new FixedLengthStream(entry.size);
  const stored = bucket.put(key, readable, opts);
  const abort = new AbortController();
  const read = entry.body.pipeTo(writable, { signal: abort.signal });
  // A failed PUT stops consumption. Abort the producer as well, so neither
  // branch waits forever on backpressure. Both failures are observed.
  void stored.catch(error => {
    abort.abort(error);
    void readable.cancel(error).catch(() => {});
  });
  void read.catch(() => {});
  return { read, stored };
}

// Returns a safe relative key, or null to skip the entry.
export function safePath(raw: string): string | null {
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
    return { kind: "invalid", message: "zip is not supported — send a tar (tar cf - -C ./dist .)" };
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
      message: "unrecognized body — send a tar, a .md/.html document, or name it with ?file=<name>",
    };
  }
  // Named so it serves at `/`: html as-is, markdown as the docs home.
  return { kind: "file", name: kind === "html" ? "index.html" : "README.md" };
}

// Reads a request body fully into memory, aborting past `max` bytes. Only a
// single file sent without Content-Length lands here (archives stream).
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
      if (total > max) throw new TarLimitError(`a body over ${max} bytes needs a Content-Length header`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
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

export async function handlePublish(req: Request, env: Env, rawId: string): Promise<Response> {
  if (!req.body) return json({ error: "empty body — pipe a tar or a single file" }, 400);

  // Per-IP throttle before any account minting or R2 work — this is the main
  // lever against anonymous mass-publishing / storage exhaustion.
  if (!(await env.PUBLISH_LIMITER.limit({ key: clientIp(req) })).success) {
    return json({ error: "rate limit exceeded — slow down and retry shortly" }, 429);
  }

  const url = new URL(req.url);
  const siteId = sanitizeSiteId(rawId);
  if (!siteId) return json({ error: `invalid share id: ${rawId}` }, 400);
  const modeParam = url.searchParams.get("mode") ?? "replace";
  if (modeParam !== "replace" && modeParam !== "merge") return json({ error: "mode must be replace or merge" }, 400);
  const merge = modeParam === "merge";

  let username: string;
  let plan: "free" | "paid" = "free";
  let isNewUser = false;
  let secret: string | undefined;

  if (req.headers.has("authorization")) {
    const owner = await verifyOwner(req, env);
    if (!owner.ok) return json({ error: owner.error }, owner.status);
    username = owner.ctx.username;
    plan = owner.ctx.user.plan;
  } else {
    // Anonymous → always a brand-new account (owned shares require the token).
    do {
      username = generateUsername();
    } while (await env.SITES.head(userKey(username)));
    secret = generateOwnerToken();
    isNewUser = true;
  }

  // Fail fast on over-quota: the share may hold what the account has left
  // after other shares and its own pending uploads.
  const limits = LIMITS[plan];
  const [otherUsage, record, listed] = isNewUser
    ? [0, null, []]
    : await Promise.all([
        userUsage(env.SITES, username, siteId),
        getMeta(env.SITES, username, siteId),
        listAll(env.SITES, sitePrefix(username, siteId)),
      ]);
  const existingMeta = record ? await reconcileUploads(env.SITES, username, siteId, record, Date.now(), listed) : null;
  const pending = existingMeta?.pending ?? {};
  const reservations = Object.values(pending);
  const reserved = reservations.reduce((sum, p) => sum + Math.max(p.bytes, p.previous?.bytes ?? 0), 0);
  const previousBytes = reservations.reduce((sum, p) => sum + (p.previous?.bytes ?? 0), 0);
  const previousFiles = reservations.filter(p => p.previous).length;
  const totalBudget = Math.max(0, limits.perUser - otherUsage - reserved);
  // Uploads still in flight are neither counted here nor orphaned below.
  const existing = new Map(committedFiles(listed, username, siteId, existingMeta).map(o => [o.key, o.size]));

  const gate = new PutGate(PUT_CONCURRENCY);
  const writtenKeys = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  if (merge) for (const size of existing.values()) { totalBytes += size; fileCount++; }
  let perr: PublishError | null = null;

  // Account for a file about to be written at `key`, or say why it can't be.
  const admit = (key: string, size: number): PublishError | null => {
    const path = key.slice(sitePrefix(username, siteId).length);
    if (pending[path]) return fail(409, `an upload is already pending at ${path}`);
    const replaced = merge && !writtenKeys.has(key) ? existing.get(key) : undefined;
    const bytes = totalBytes - (replaced ?? 0) + size;
    const files = fileCount + (replaced === undefined ? 1 : 0);
    if (files + reservations.length > MAX_FILES) return fail(413, `too many files; max is ${MAX_FILES}`);
    if (bytes > totalBudget) return fail(413, `account storage exceeded: ${totalBudget} bytes left (plan ${plan})`);
    totalBytes = bytes;
    fileCount = files;
    writtenKeys.add(key);
    return null;
  };

  // Peek before branching: the payload's own bytes decide archive-vs-document,
  // with the Content-Type header as a fallback rather than the source of truth.
  let payload: Awaited<ReturnType<typeof peek>>;
  try { payload = await peek(req.body); }
  catch { return json({ error: "failed to read request body" }, 400); }
  const { head, stream: body, cancel: cancelBody } = payload;
  const mode = detectMode(req, url, head);
  if (mode.kind === "invalid") {
    void cancelBody().catch(() => {});
    return json({ error: mode.message }, 400);
  }

  try {
    if (mode.kind === "file") {
      // Single raw document: no archive to stream, so read the body directly and
      // write it under a name that serves at `/`.
      const name = mode.name;
      const key = siteFileKey(username, siteId, name);
      if (RESERVED_FILE(name)) perr = fail(400, `reserved filename: ${name}`);
      else {
        const lengthHeader = req.headers.get("content-length");
        const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
        if (declared !== null && !Number.isSafeInteger(declared)) {
          throw new TarLimitError(`file is ${declared} bytes; max is ${MAX_FILE_BYTES}`);
        }
        if (declared === 0) {
          void cancelBody().catch(() => {});
          return json({ error: "empty file" }, 400);
        }
        if (declared !== null) {
          perr = admit(key, declared);
          if (!perr) {
            const { readable, writable } = new FixedLengthStream(declared);
            const stored = env.SITES.put(key, readable, { httpMetadata: { contentType: contentTypeFor(name) } });
            const abort = new AbortController();
            void stored.catch(error => {
              abort.abort(error);
              void readable.cancel(error).catch(() => {});
              void cancelBody(error).catch(() => {});
            });
            await Promise.all([body.pipeTo(writable, { signal: abort.signal }), stored]);
          }
        } else {
          const bytes = await readBounded(body, MAX_BUFFERED_BYTES);
          if (bytes.byteLength === 0) perr = fail(400, "empty file");
          else perr = admit(key, bytes.byteLength);
          if (!perr) await env.SITES.put(key, bytes, { httpMetadata: { contentType: contentTypeFor(name) } });
        }
      }
    } else {
      // Bare tars are accepted too — only gzipped bodies go through the inflater.
      const stream = mode.gzipped ? gunzipStream(body) : body;
      // A header declaring more than the account has left fails before its bytes are read.
      for await (const entry of parseTar(stream, { maxEntrySize: Math.min(MAX_FILE_BYTES, totalBudget) })) {
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
        if (RESERVED_FILE(path)) continue;

        const key = siteFileKey(username, siteId, path);
        perr = admit(key, entry.size);
        if (perr) break;
        const { read, stored } = streamEntry(env.SITES, key, entry, contentTypeFor(path));
        await gate.add(() => stored);
        await read;
      }
      await gate.drain();
    }
  } catch (e) {
    void cancelBody(e).catch(() => {});
    if (perr) return json({ error: perr.message }, perr.status);
    if (e instanceof TarLimitError) return json({ error: e.message }, 413);
    const message = e instanceof Error ? e.message : "failed to read archive";
    return json({ error: `bad archive: ${message}` }, 400);
  }

  if (perr) {
    void cancelBody().catch(() => {});
    return json({ error: perr.message }, perr.status);
  }
  if (writtenKeys.size === 0) return json({ error: "archive contained no files" }, 400);

  if (!merge) await deleteKeys(env.SITES, [...existing.keys()].filter((k) => !writtenKeys.has(k)));

  if (isNewUser) {
    await putUser(env.SITES, username, {
      tokenHash: await sha256Hex(secret!),
      plan: "free",
      createdAt: Date.now(),
    });
  }

  // Mint an access key only on a share's first publish; redeploys keep the key
  // and visibility so share links keep working.
  const meta: SiteMeta = {
    ...existingMeta,
    ...(existingMeta?.accessKey || existingMeta?.keyHash ? {} : { accessKey: generateAccessKey() }),
    generation: (existingMeta?.generation ?? 0) + 1,
    createdAt: existingMeta?.createdAt ?? Date.now(),
    lastDeployAt: Date.now(),
    bytes: totalBytes + previousBytes,
    fileCount: fileCount + previousFiles,
    public: existingMeta?.public ?? false,
  };
  await putMeta(env.SITES, username, siteId, meta);

  return json({
    url: metaUrl(siteHost(username, siteId, env.APEX_HOST), meta),
    id: siteId,
    username,
    fileCount: meta.fileCount,
    bytes: meta.bytes,
    ...(secret ? { ownerToken: `${username}.${secret}` } : {}),
  });
}
