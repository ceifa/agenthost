// Presigned uploads into a share: the Worker reserves quota and signs an
// exact-size PUT to the file's final key; the bytes travel client → R2 and never
// cross the Worker. Completing checks the object and commits a new generation.

import { LIMITS, MAX_FILE_BYTES, MAX_FILES, UPLOAD_EXPIRY_MS, UPLOAD_URL_TTL_SECONDS } from "./config";
import { ownedShare, readJson, requireOwner, type AppContext } from "./auth";
import { committedFiles, getMeta, listAll, putMeta, shareUsage, siteFileKey, sitePrefix, userUsage, RESERVED_FILE, type SiteMeta } from "./storage";
import { clientIp, generateAccessKey, metaUrl, sanitizeSiteId, siteHost } from "./ids";
import { routeFilePath, safePath } from "./publish";
import { signDirectUpload } from "./r2-signed";

// The file path after /shares/{id}/uploads/{prepare|complete}/.
function uploadPath(c: AppContext): string | null {
  const raw = routeFilePath(c.req.url, 4);
  if (raw === null || raw.length > 512) return null;
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
  const path = uploadPath(c);
  if (!path) return c.json({ error: "valid file path required" }, 400);
  const body = await readJson(c);
  if (!body) return c.json({ error: "JSON body required" }, 400);
  const bytes = body.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return c.json({ error: "bytes must be a positive integer" }, 400);
  }
  // Optional: without it the file is served with the type of its extension.
  const contentType = body.contentType;
  if (contentType !== undefined && (typeof contentType !== "string" || contentType.length > 120 ||
      !/^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(contentType))) {
    return c.json({ error: "contentType must be a MIME type" }, 400);
  }

  const limits = LIMITS[owner.user.plan];
  if (bytes > MAX_FILE_BYTES) return c.json({ error: `file is ${bytes} bytes; max is ${MAX_FILE_BYTES}` }, 413);
  const key = siteFileKey(owner.username, id, path);
  const [otherUsage, existing, current] = await Promise.all([
    userUsage(c.env.SITES, owner.username, id),
    getMeta(c.env.SITES, owner.username, id),
    c.env.SITES.head(key),
  ]);
  const now = Date.now();
  const meta: SiteMeta = existing ?? {
    generation: 0, createdAt: now, lastDeployAt: now, bytes: 0, fileCount: 0, accessKey: generateAccessKey(), public: false,
  };
  // The upload replaces whatever is at `path`: a committed file or an earlier
  // reservation for the same path.
  const pending = { ...meta.pending };
  const replacesFile = !!current && !pending[path];
  delete pending[path];
  const shareBytes = shareUsage({ ...meta, pending }) - (replacesFile ? current.size : 0) + bytes;
  const files = meta.fileCount + Object.keys(pending).length + (replacesFile ? 0 : 1);
  if (files > MAX_FILES) return c.json({ error: `too many files; max is ${MAX_FILES}` }, 413);
  if (shareBytes > limits.perUser - otherUsage) {
    return c.json({ error: `account storage exceeded (plan ${owner.user.plan})` }, 413);
  }

  let upload;
  try {
    upload = await signDirectUpload(c.env, key, { bytes, contentType: contentType?.toLowerCase(), expiresIn: UPLOAD_URL_TTL_SECONDS });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "direct R2 uploads are not configured" }, 503);
  }
  pending[path] = { bytes, expiresAt: now + UPLOAD_EXPIRY_MS };
  await putMeta(c.env.SITES, owner.username, id, { ...meta, pending });
  return c.json({
    uploadUrl: upload.url,
    uploadHeaders: upload.headers,
    uploadExpiresIn: upload.expiresIn,
    url: metaUrl(siteHost(owner.username, id, c.env.APEX_HOST), meta),
  });
}

export async function completeUpload(c: AppContext): Promise<Response> {
  const share = await ownedShare(c);
  if (share instanceof Response) return share;
  const { owner, id, meta } = share;
  const path = uploadPath(c);
  const reserved = path ? meta.pending?.[path] : undefined;
  if (!path || !reserved) return c.json({ error: "no pending upload at that path" }, 404);

  // One LIST both finds the upload and recounts the tree.
  const key = siteFileKey(owner.username, id, path);
  const listed = await listAll(c.env.SITES, sitePrefix(owner.username, id));
  const object = listed.find(o => o.key === key);
  if (!object) return c.json({ error: "upload not found in R2 — PUT the file before completing" }, 409);
  const pending = { ...meta.pending };
  delete pending[path];
  if (object.size !== reserved.bytes) {
    await c.env.SITES.delete(key);
    await putMeta(c.env.SITES, owner.username, id, { ...meta, pending });
    return c.json({ error: `uploaded size is ${object.size}; expected ${reserved.bytes}; object deleted` }, 400);
  }

  const files = committedFiles(listed, owner.username, id, { ...meta, pending });
  const next: SiteMeta = {
    ...meta,
    pending,
    generation: meta.generation + 1,
    lastDeployAt: Date.now(),
    bytes: files.reduce((n, o) => n + o.size, 0),
    fileCount: files.length,
  };
  if (!Object.keys(pending).length) delete next.pending;
  await putMeta(c.env.SITES, owner.username, id, next);
  return c.json({ url: metaUrl(siteHost(owner.username, id, c.env.APEX_HOST), next), id, path, bytes: next.bytes, fileCount: next.fileCount });
}
