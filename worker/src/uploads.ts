// Presigned uploads into a share: the Worker reserves quota and signs an
// exact-size PUT to the file's final key; the bytes travel client → R2 and never
// cross the Worker. Reads recognize successful writes without a completion call.

import { LIMITS, MAX_FILE_BYTES, MAX_FILES, UPLOAD_EXPIRY_MS, UPLOAD_URL_TTL_SECONDS } from "./config";
import { readJson, requireOwner, type AppContext } from "./auth";
import { getMeta, putMeta, reconcileUploads, shareUsage, siteFileKey, userUsage, RESERVED_FILE, type SiteMeta } from "./storage";
import { clientIp, contentTypeFor, generateAccessKey, metaUrl, sanitizeSiteId, siteHost } from "./ids";
import { safePath } from "./publish";
import { signDirectUpload } from "./r2-signed";

function safeContentType(raw: unknown, path: string): string {
  if (typeof raw === "string" && raw.length <= 120 && /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(raw)) {
    return raw.toLowerCase();
  }
  return contentTypeFor(path);
}

function uploadPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const path = safePath(raw);
  return path && !RESERVED_FILE(path) ? path : null;
}

export async function createUpload(c: AppContext): Promise<Response> {
  if (!(await c.env.PUBLISH_LIMITER.limit({ key: `upload:${clientIp(c.req.raw)}` })).success) {
    return c.json({ error: "rate limit exceeded — slow down and retry shortly" }, 429);
  }
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const id = sanitizeSiteId(c.req.param("id"));
  if (!id) return c.json({ error: "invalid share id" }, 400);
  const body = await readJson(c);
  if (!body) return c.json({ error: "JSON body required" }, 400);
  const path = uploadPath(body.path);
  if (!path) return c.json({ error: "valid path required" }, 400);
  const bytes = body.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return c.json({ error: "bytes must be a positive integer" }, 400);
  }

  const limits = LIMITS[owner.user.plan];
  if (bytes > MAX_FILE_BYTES) return c.json({ error: `file is ${bytes} bytes; max is ${MAX_FILE_BYTES}` }, 413);
  const key = siteFileKey(owner.username, id, path);
  const [otherUsage, existing] = await Promise.all([
    userUsage(c.env.SITES, owner.username, id),
    getMeta(c.env.SITES, owner.username, id),
  ]);
  const now = Date.now();
  const meta: SiteMeta = existing ? await reconcileUploads(c.env.SITES, owner.username, id, existing, now) : {
    generation: 0, createdAt: now, lastDeployAt: now, bytes: 0, fileCount: 0, accessKey: generateAccessKey(), public: false,
  };
  if (meta.pending?.[path]) return c.json({ error: "an upload is already pending at that path" }, 409);
  const current = await c.env.SITES.head(key);
  const pending = { ...meta.pending };
  const shareBytes = shareUsage(meta) + Math.max(0, bytes - (current?.size ?? 0));
  const files = meta.fileCount + Object.values(pending).filter(p => !p.previous).length + (current ? 0 : 1);
  if (files > MAX_FILES) return c.json({ error: `too many files; max is ${MAX_FILES}` }, 413);
  if (shareBytes > limits.perUser - otherUsage) {
    return c.json({ error: `account storage exceeded (plan ${owner.user.plan})` }, 413);
  }

  let upload;
  try {
    upload = await signDirectUpload(c.env, key, { bytes, contentType: safeContentType(body.contentType, path), expiresIn: UPLOAD_URL_TTL_SECONDS, etag: current?.httpEtag });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "direct R2 uploads are not configured" }, 503);
  }
  pending[path] = { bytes, expiresAt: now + UPLOAD_EXPIRY_MS, ...(current ? { previous: { version: current.version, bytes: current.size } } : {}) };
  await putMeta(c.env.SITES, owner.username, id, { ...meta, lastDeployAt: now, pending });
  return c.json({
    uploadUrl: upload.url,
    uploadHeaders: upload.headers,
    uploadExpiresIn: upload.expiresIn,
    url: metaUrl(siteHost(owner.username, id, c.env.APEX_HOST), meta),
  });
}
