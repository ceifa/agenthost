// Direct asset uploads and download pages. Only JSON/HTML and R2 HEAD requests
// cross the Worker; PUT/GET payloads use short-lived, object-scoped R2 URLs.

import { ASSET_LIMITS } from "./config";
import { checkAccessKey, requireOwner, type AppContext } from "./auth";
import {
  assetMetaKey,
  assetObjectKey,
  assetUsage,
  getAssetMeta,
  putAssetMeta,
  userUsage,
  type AssetMeta,
} from "./storage";
import {
  clientIp,
  contentTypeFor,
  generateAccessKey,
  sha256Hex,
} from "./ids";
import { signDirectDownload, signDirectUpload } from "./r2-signed";
import { assetDownloadHtml, assetPendingHtml, notFoundHtml } from "./templates";

const ASSET_COOKIE_PREFIX = "aa_auth_";

export function safeAssetName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\\/g, "/").split("/").pop()!.trim();
  if (!name || name === "." || name === ".." || name.length > 180 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function safeContentType(raw: unknown, name: string): string {
  if (typeof raw === "string" && raw.length <= 120 && /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(raw)) {
    return raw.toLowerCase();
  }
  return contentTypeFor(name);
}

export function attachmentDisposition(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function html(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      ...headers,
    },
  });
}

function assetUrl(apex: string, username: string, id: string): string {
  return `https://${apex}/a/${encodeURIComponent(username)}/${encodeURIComponent(id)}`;
}

async function ownedAsset(c: AppContext, username: string, id: string): Promise<AssetMeta | Response> {
  const meta = await getAssetMeta(c.env.SITES, username, id);
  if (!meta) return c.json({ error: "asset not found" }, 404);
  return meta;
}

export async function createAsset(c: AppContext): Promise<Response> {
  if (!(await c.env.PUBLISH_LIMITER.limit({ key: `asset:${clientIp(c.req.raw)}` })).success) {
    return c.json({ error: "rate limit exceeded — slow down and retry shortly" }, 429);
  }
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;

  let body: Record<string, unknown> | null;
  try {
    body = await c.req.json<Record<string, unknown> | null>();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return c.json({ error: "JSON body required" }, 400);
  const name = safeAssetName(body.name);
  const bytes = body.bytes;
  if (!name) return c.json({ error: "valid file name required (max 180 characters)" }, 400);
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return c.json({ error: "bytes must be a positive integer" }, 400);
  }

  const limit = ASSET_LIMITS[owner.user.plan];
  if (bytes > limit.perAsset) {
    return c.json({ error: `asset is ${bytes} bytes; plan ${owner.user.plan} allows ${limit.perAsset}` }, 413);
  }
  const [siteBytes, existingAssetBytes] = await Promise.all([
    userUsage(c.env.SITES, owner.username, undefined, owner.user),
    assetUsage(c.env.SITES, owner.username),
  ]);
  if (siteBytes + existingAssetBytes + bytes > limit.perUser) {
    return c.json({ error: `account exceeds asset storage budget of ${limit.perUser} bytes` }, 413);
  }

  const id = generateAccessKey(16);
  const key = assetObjectKey(owner.username, id);
  const contentType = safeContentType(body.contentType, name);
  const accessKey = generateAccessKey();
  const now = Date.now();
  const meta: AssetMeta = {
    id,
    username: owner.username,
    name,
    contentType,
    bytes,
    objectKey: key,
    keyHash: await sha256Hex(accessKey),
    public: false,
    status: "pending",
    createdAt: now,
    lastDeployAt: now,
  };

  let upload;
  try {
    upload = await signDirectUpload(c.env, key, {
      bytes,
      contentType,
      contentDisposition: attachmentDisposition(name),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "direct R2 uploads are not configured";
    return c.json({ error: message }, 503);
  }

  await putAssetMeta(c.env.SITES, owner.username, id, meta);
  const url = assetUrl(c.env.APEX_HOST, owner.username, id);
  return c.json({
    assetId: id,
    name,
    bytes,
    contentType,
    uploadUrl: upload.url,
    uploadHeaders: upload.headers,
    uploadExpiresIn: upload.expiresIn,
    completeUrl: `${url}/complete?username=${encodeURIComponent(owner.username)}`,
    url: `${url}?k=${accessKey}`,
  });
}

export async function completeAsset(c: AppContext): Promise<Response> {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const id = c.req.param("id");
  if (!id || c.req.param("username") !== owner.username) return c.json({ error: "asset not found" }, 404);
  const found = await ownedAsset(c, owner.username, id);
  if (found instanceof Response) return found;

  const object = await c.env.SITES.head(found.objectKey);
  if (!object) return c.json({ error: "upload not found in R2 — upload the file before completing" }, 409);
  if (object.size !== found.bytes) {
    await c.env.SITES.delete(found.objectKey);
    return c.json({ error: `uploaded size is ${object.size}; expected ${found.bytes}; object deleted` }, 400);
  }

  const ready: AssetMeta = { ...found, status: "ready", readyAt: Date.now(), lastDeployAt: Date.now() };
  await putAssetMeta(c.env.SITES, owner.username, id, ready);
  return c.json({ ok: true, url: assetUrl(c.env.APEX_HOST, owner.username, id), name: ready.name, bytes: ready.bytes });
}

export async function deleteAsset(c: AppContext): Promise<Response> {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const id = c.req.param("id");
  if (!id || c.req.param("username") !== owner.username) return c.json({ error: "asset not found" }, 404);
  const found = await ownedAsset(c, owner.username, id);
  if (found instanceof Response) return found;
  await Promise.all([
    c.env.SITES.delete(found.objectKey),
    c.env.SITES.delete(assetMetaKey(owner.username, id)),
  ]);
  return c.json({ ok: true });
}

export async function serveAsset(c: AppContext): Promise<Response> {
  const username = c.req.param("username");
  const id = c.req.param("id");
  if (!username || !id) return html(notFoundHtml(), 404);
  const meta = await getAssetMeta(c.env.SITES, username, id);
  if (!meta) return html(notFoundHtml(), 404);

  let accessKey: string | null = null;
  if (!meta.public) {
    const gate = await checkAccessKey(c.req.raw, c.env, {
      keyHash: meta.keyHash,
      label: meta.name,
      cookieName: ASSET_COOKIE_PREFIX + id,
      cookiePath: `/a/${encodeURIComponent(username)}/${encodeURIComponent(id)}`,
      limiterKey: `asset:${id}`,
    });
    if (gate instanceof Response) return gate;
    accessKey = gate;
  }

  if (meta.status !== "ready") return html(assetPendingHtml(meta.name), 425);
  if (!(await c.env.SITES.head(meta.objectKey))) return html(notFoundHtml(), 404);

  let downloadUrl: string;
  try {
    downloadUrl = (await signDirectDownload(c.env, meta.objectKey)).url;
  } catch {
    return html(notFoundHtml(), 503);
  }
  const share = `${assetUrl(c.env.APEX_HOST, username, id)}${accessKey ? `?k=${accessKey}` : ""}`;
  return html(assetDownloadHtml({ name: meta.name, bytes: meta.bytes, contentType: meta.contentType, downloadUrl, shareUrl: share }));
}
