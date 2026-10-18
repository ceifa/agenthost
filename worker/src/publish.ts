// POST /publish — streaming files → bounded R2 puts → delete orphans → commit
// generation and access metadata together.

import type { Env } from "./env";
import { LIMITS, PUT_CONCURRENCY, DEFAULT_SITE_ID, type PlanLimits } from "./config";
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
} from "./ids";
import { json, clientIp } from "./http";
import { verifyOwner } from "./auth";
import { parseTar, TarLimitError, type TarEntry } from "./tar";
import { gunzipStream } from "./gunzip";
import { peek, isGzip, isTar, isZip, sniffDocKind } from "./sniff";
import {
  putUser,
  getMeta,
  putMeta,
  getGen,
  assetUsage,
  siteRecords,
  listAll,
  siteFileKey,
  sitePrefix,
  userKey,
  legacyMetaKey,
  genKey,
  deleteKeys,
  isReservedFile,
  type SiteMeta,
  type UserRecord,
} from "./storage";

// A request we refuse, with the status to refuse it with.
class PublishError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ── reading the body ──

// Returns a safe relative key, or null to skip the entry.
function safePath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
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
  | { kind: "archive"; gzipped: boolean };

function named(raw: string): Mode {
  const name = safePath(raw);
  if (!name) throw new PublishError(400, `invalid file name: ${raw}`);
  return { kind: "file", name };
}

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
    throw new PublishError(400, "zip is not supported — send a tar (tar cf - -C ./dist .)");
  }

  // Not an archive, so it's one document: prefer the name it came with, since the
  // extension is a better signal than anything we can infer.
  const filename = dispositionFileName(req);
  if (filename !== null) return named(filename);

  // Header next (it's an explicit claim), then the bytes themselves: front
  // matter → markdown, a doctype/html tag → html, prose → markdown.
  const kind = singleFileKind(contentType) ?? sniffDocKind(head);
  if (kind === null) {
    throw new PublishError(400, "unrecognized body — send a tar, a .md/.html document, or name it with ?file=<name>");
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
      if (total > max) throw new PublishError(413, `file is ${total}+ bytes; max is ${max}`);
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

// ── writing files ──

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

// Streams `size` bytes into R2 without buffering them. `read` settles once the
// source is consumed; `stored` settles when R2 has the object.
function streamToR2(
  bucket: R2Bucket,
  key: string,
  source: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
): { read: Promise<void>; stored: Promise<unknown> } {
  const opts = { httpMetadata: { contentType } };
  if (size === 0) return { read: Promise.resolve(), stored: bucket.put(key, new Uint8Array(0), opts) };
  // R2 needs the length up front; FixedLengthStream carries it and rejects a mismatch.
  const { readable, writable } = new FixedLengthStream(size);
  const stored = bucket.put(key, readable, opts);
  const abort = new AbortController();
  const read = source.pipeTo(writable, { signal: abort.signal });
  // A failed PUT stops consumption. Abort the producer as well, so neither
  // branch waits forever on backpressure. Both failures are observed.
  void stored.catch(error => {
    abort.abort(error);
    void readable.cancel(error).catch(() => {});
  });
  void read.catch(() => {});
  return { read, stored };
}

interface Written {
  keys: Set<string>;
  bytes: number;
  fileCount: number;
}

interface Target {
  bucket: R2Bucket;
  username: string;
  siteId: string;
  limits: PlanLimits;
  budget: number; // bytes this site may hold: min(per-site cap, account quota left)
  budgetError: () => PublishError;
}

// One raw document, written under a name that serves at `/`.
async function writeDocument(
  t: Target,
  name: string,
  req: Request,
  body: ReadableStream<Uint8Array>,
  cancelBody: (reason?: unknown) => Promise<void>,
): Promise<Written> {
  if (isReservedFile(name)) throw new PublishError(400, `reserved filename: ${name}`);
  const cap = Math.min(t.limits.perFile, t.budget);
  const lengthHeader = req.headers.get("content-length");
  const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > cap)) {
    throw new PublishError(413, `file is ${declared} bytes; max is ${cap}`);
  }
  if (declared === 0) throw new PublishError(400, "empty file");

  const key = siteFileKey(t.username, t.siteId, name);
  const contentType = contentTypeFor(name);
  if (declared !== null) {
    const { read, stored } = streamToR2(t.bucket, key, body, declared, contentType);
    // The replayed body can sit in a pending pull; stop the request itself too.
    void stored.catch(error => void cancelBody(error).catch(() => {}));
    await Promise.all([read, stored]);
    return { keys: new Set([key]), bytes: declared, fileCount: 1 };
  }

  const bytes = await readBounded(body, cap);
  if (bytes.byteLength === 0) throw new PublishError(400, "empty file");
  if (bytes.byteLength > t.budget) throw t.budgetError();
  await t.bucket.put(key, bytes, { httpMetadata: { contentType } });
  return { keys: new Set([key]), bytes: bytes.byteLength, fileCount: 1 };
}

// A tar (optionally gzipped), each entry streamed into R2 as it arrives.
async function writeArchive(t: Target, stream: ReadableStream<Uint8Array>): Promise<Written> {
  const gate = new PutGate(PUT_CONCURRENCY);
  const written: Written = { keys: new Set(), bytes: 0, fileCount: 0 };
  try {
    // The parser enforces the per-file cap on each header, so an inflated size
    // can't make it buffer a giant entry.
    for await (const entry of parseTar(stream, { maxEntrySize: t.limits.perFile })) {
      if (entry.type === "symlink" || entry.type === "hardlink") {
        throw new PublishError(400, `links are not allowed (${entry.path})`);
      }
      if (entry.type !== "file") continue;

      const path = safePath(entry.path);
      if (path === null) {
        if (entry.path.split("/").includes("..")) throw new PublishError(400, `unsafe path rejected: ${entry.path}`);
        continue; // silently skipped cruft (._*, .DS_Store, dirs)
      }
      // Never let a user file clobber the per-site control objects.
      if (isReservedFile(path)) continue;

      if (written.fileCount + 1 > t.limits.filesPerSite) {
        throw new PublishError(413, `too many files; max is ${t.limits.filesPerSite}`);
      }
      if (written.bytes + entry.size > t.budget) throw t.budgetError();

      written.bytes += entry.size;
      written.fileCount += 1;
      const key = siteFileKey(t.username, t.siteId, path);
      written.keys.add(key);
      const { read, stored } = streamToR2(t.bucket, key, entry.body, entry.size, contentTypeFor(path));
      await gate.add(() => stored);
      await read;
    }
  } catch (error) {
    // Let in-flight puts settle before refusing; their errors lose to the refusal.
    if (error instanceof PublishError) await gate.drain().catch(() => {});
    throw error;
  }
  await gate.drain();
  if (written.fileCount === 0) throw new PublishError(400, "archive contained no files");
  return written;
}

function failureResponse(error: unknown): Response {
  if (error instanceof PublishError) return json({ error: error.message }, error.status);
  if (error instanceof TarLimitError) return json({ error: error.message }, 413);
  const message = error instanceof Error ? error.message : "failed to read archive";
  return json({ error: `bad archive: ${message}` }, 400);
}

// ── the request ──

interface Account {
  username: string;
  plan: "free" | "paid";
  user?: UserRecord; // absent for an account this request is minting
  ownerToken?: string; // only for a new account — returned once, never stored
}

async function resolveAccount(req: Request, env: Env): Promise<Account | Response> {
  if (req.headers.has("authorization")) {
    const owner = await verifyOwner(req, env);
    if (!owner.ok) return json({ error: owner.error }, owner.status);
    return { username: owner.ctx.username, plan: owner.ctx.user.plan, user: owner.ctx.user };
  }
  // Anonymous → always a brand-new account (owned sites require the token).
  let username: string;
  do {
    username = generateUsername();
  } while (await env.SITES.head(userKey(username)));
  return { username, plan: "free", ownerToken: generateOwnerToken() };
}

// Bytes held by the account's other sites, and — while its inventory is still
// being migrated off the legacy layout — which of those remain legacy.
async function inventory(bucket: R2Bucket, username: string, siteId: string, account: UserRecord) {
  let bytes = 0;
  const migrating = account.legacySiteIds === undefined || account.legacySiteIds.includes(siteId);
  const legacySiteIds: string[] = [];
  for await (const site of siteRecords(bucket, username, account, siteId)) {
    bytes += site.meta.bytes ?? 0;
    if (migrating && site.meta.generation === undefined) legacySiteIds.push(site.siteId);
  }
  return { bytes, migrating, legacySiteIds };
}

export async function handlePublish(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!req.body) return json({ error: "empty body — pipe a tar or a single file" }, 400);

  // Per-IP throttle before any account minting or R2 work — this is the main
  // lever against anonymous mass-publishing / storage exhaustion.
  if (!(await env.PUBLISH_LIMITER.limit({ key: clientIp(req) })).success) {
    return json({ error: "rate limit exceeded — slow down and retry shortly" }, 429);
  }

  const url = new URL(req.url);
  const account = await resolveAccount(req, env);
  if (account instanceof Response) return account;
  const { username, plan, user } = account;
  const siteId = sanitizeSiteId(url.searchParams.get("id") ?? req.headers.get("x-agenthost-site")) ?? DEFAULT_SITE_ID;

  // Fail fast on over-quota: budget = min(per-site cap, account quota minus other sites).
  const limits = LIMITS[plan];
  const [otherSites, assetBytes, existingMeta] = user
    ? await Promise.all([
        inventory(env.SITES, username, siteId, user),
        assetUsage(env.SITES, username),
        getMeta(env.SITES, username, siteId),
      ])
    : [{ bytes: 0, migrating: false, legacySiteIds: [] }, 0, null] as const;
  const budget = Math.min(limits.perSite, Math.max(0, limits.perUser - otherSites.bytes - assetBytes));
  const target: Target = {
    bucket: env.SITES, username, siteId, limits, budget,
    budgetError: () => new PublishError(413, `site exceeds size budget of ${budget} bytes (plan ${plan})`),
  };

  // Peek before branching: the payload's own bytes decide archive-vs-document,
  // with the Content-Type header as a fallback rather than the source of truth.
  let payload: Awaited<ReturnType<typeof peek>>;
  try {
    payload = await peek(req.body);
  } catch {
    return json({ error: "failed to read request body" }, 400);
  }
  const { head, stream: body, cancel: cancelBody } = payload;

  let written: Written;
  try {
    const mode = detectMode(req, url, head);
    written = mode.kind === "file"
      ? await writeDocument(target, mode.name, req, body, cancelBody)
      : await writeArchive(target, mode.gzipped ? gunzipStream(body) : body); // bare tars skip the inflater
  } catch (error) {
    void cancelBody(error).catch(() => {});
    return failureResponse(error);
  }

  // Delete files removed since the last deploy (keep the _gen/_meta control
  // objects). A brand-new username can't have prior objects — skip the list.
  if (user) {
    const prefix = sitePrefix(username, siteId);
    const orphans = (await listAll(env.SITES, prefix))
      .map((o) => o.key)
      .filter((k) => !isReservedFile(k.slice(prefix.length)) && !written.keys.has(k));
    await deleteKeys(env.SITES, orphans);
  } else {
    await putUser(env.SITES, username, {
      tokenHash: await sha256Hex(account.ownerToken!),
      legacySiteIds: [],
      plan: "free",
      createdAt: Date.now(),
    });
  }

  // Mint an access key only on a site's first publish (or if one is missing);
  // redeploys preserve the existing keyHash/public so share links keep working.
  let keyHash = existingMeta?.keyHash ?? "";
  let accessKey: string | undefined;
  if (!keyHash) {
    accessKey = generateAccessKey();
    keyHash = await sha256Hex(accessKey);
  }

  const previousGen = existingMeta ? existingMeta.generation ?? await getGen(env.SITES, username, siteId) : 0;
  const generation = previousGen + 1;
  const meta: SiteMeta = {
    generation,
    createdAt: existingMeta?.createdAt ?? Date.now(),
    lastDeployAt: Date.now(),
    bytes: written.bytes,
    fileCount: written.fileCount,
    keyHash,
    public: existingMeta?.public ?? false,
    ...(existingMeta?.tombstone ? { tombstone: true } : {}),
  };
  await putMeta(env.SITES, username, siteId, meta);

  // Remove old controls before updating the inventory. If that final account
  // write fails, legacy enumeration still discovers the new record through the
  // site's unchanged file prefix, and the next publish can finish migration.
  if (existingMeta && existingMeta.generation === undefined) {
    await env.SITES.delete([legacyMetaKey(username, siteId), genKey(username, siteId)]);
  }

  // The merged record commits generation and access state in one PUT. While
  // migrating, the catalog write replaces the old separate generation PUT.
  if (user && otherSites.migrating) {
    await putUser(env.SITES, username, { ...user, legacySiteIds: otherSites.legacySiteIds });
  }

  const host = siteHost(username, siteId, env.APEX_HOST);
  return json({
    url: siteUrl(host),
    shareUrl: shareUrl(host, accessKey),
    username,
    siteId,
    generation,
    fileCount: written.fileCount,
    bytes: written.bytes,
    ...(accessKey ? { accessKey } : {}),
    ...(account.ownerToken ? { ownerToken: account.ownerToken, claimUrl: `https://${env.APEX_HOST}/claim?username=${username}` } : {}),
  });
}
