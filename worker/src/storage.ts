// R2 key layout + typed accessors for the metadata objects. R2 is the only
// store; read-after-write is strongly consistent per object, which is what lets
// the publish→serve loop work without any other coordination primitive.

export interface SiteMeta {
  createdAt: number;
  lastDeployAt: number;
  bytes: number;
  fileCount: number;
  keyHash: string | null; // sha256(accessKey); null only mid-first-publish
  public: boolean;
  tombstone?: boolean; // takedown marker → serve 410
}

export interface UserRecord {
  tokenHash: string; // sha256(ownerToken); the secret itself is never stored
  email?: string; // optional, unverified contact (set on claim)
  plan: "free" | "paid";
  customDomain?: string;
  createdAt: number;
}

export interface DomainRecord {
  username: string;
  siteId: string;
}

export interface AssetMeta {
  id: string;
  username: string;
  name: string;
  contentType: string;
  bytes: number;
  objectKey: string;
  keyHash: string;
  public: boolean;
  status: "pending" | "ready";
  createdAt: number;
  lastDeployAt: number;
  readyAt?: number;
}

export const siteFileKey = (u: string, s: string, path: string) => `sites/${u}/${s}/${path}`;
export const sitePrefix = (u: string, s: string) => `sites/${u}/${s}/`;
export const userSitesPrefix = (u: string) => `sites/${u}/`;
export const genKey = (u: string, s: string) => `sites/${u}/${s}/_gen`;
export const metaKey = (u: string, s: string) => `sites/${u}/${s}/_meta`;
export const userKey = (u: string) => `_users/${u}`;
export const domainKey = (host: string) => `_domains/${host}`;
export const assetObjectKey = (u: string, id: string) => `assets/${u}/${id}/blob`;
export const assetMetaKey = (u: string, id: string) => `_assets/${u}/${id}/_meta`;
export const userAssetsPrefix = (u: string) => `_assets/${u}/`;

// Control objects, never part of the served site.
export const RESERVED_FILE = (path: string) => path === "_gen" || path === "_meta";

export async function getGen(b: R2Bucket, u: string, s: string): Promise<number> {
  const obj = await b.get(genKey(u, s));
  if (!obj) return 0;
  const n = parseInt(await obj.text(), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function bumpGen(b: R2Bucket, u: string, s: string): Promise<number> {
  const next = (await getGen(b, u, s)) + 1;
  await b.put(genKey(u, s), String(next));
  return next;
}

async function getJson<T>(b: R2Bucket, key: string): Promise<T | null> {
  const obj = await b.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

async function putJson(b: R2Bucket, key: string, value: unknown): Promise<void> {
  await b.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

export const getMeta = (b: R2Bucket, u: string, s: string) => getJson<SiteMeta>(b, metaKey(u, s));
export const putMeta = (b: R2Bucket, u: string, s: string, meta: SiteMeta) => putJson(b, metaKey(u, s), meta);
export const getUser = (b: R2Bucket, u: string) => getJson<UserRecord>(b, userKey(u));
export const putUser = (b: R2Bucket, u: string, rec: UserRecord) => putJson(b, userKey(u), rec);
export const getDomain = (b: R2Bucket, host: string) => getJson<DomainRecord>(b, domainKey(host));
export const putDomain = (b: R2Bucket, host: string, rec: DomainRecord) => putJson(b, domainKey(host), rec);
export const getAssetMeta = (b: R2Bucket, u: string, id: string) => getJson<AssetMeta>(b, assetMetaKey(u, id));
export const putAssetMeta = (b: R2Bucket, u: string, id: string, meta: AssetMeta) => putJson(b, assetMetaKey(u, id), meta);

// Follows pagination cursors to return every key under a prefix.
export async function listAll(b: R2Bucket, prefix: string, opts?: R2ListOptions): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const res = await b.list({ ...opts, prefix, cursor, limit: 1000 });
    out.push(...res.objects);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

// Immediate child "directories" of a prefix (delimited listing), e.g. the
// siteIds under sites/{user}/ — without enumerating every file below them.
async function listPrefixes(b: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await b.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    out.push(...res.delimitedPrefixes);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

export async function listUsers(b: R2Bucket): Promise<{ username: string; user: UserRecord }[]> {
  const objs = await listAll(b, "_users/");
  const recs = await Promise.all(
    objs.map(async (o) => {
      const user = await getJson<UserRecord>(b, o.key);
      return user ? { username: o.key.slice("_users/".length), user } : null;
    }),
  );
  return recs.filter((r): r is { username: string; user: UserRecord } => r !== null);
}

export async function listSiteMetas(
  b: R2Bucket,
  username?: string,
  exceptSiteId?: string,
): Promise<{ username: string; siteId: string; meta: SiteMeta }[]> {
  // Delimited listings enumerate sites without walking every file below them.
  const userPrefixes = username ? [userSitesPrefix(username)] : await listPrefixes(b, "sites/");
  const perUser = await Promise.all(
    userPrefixes.map(async (up) => {
      const u = up.slice("sites/".length, -1);
      const sitePrefixes = await listPrefixes(b, up);
      return Promise.all(
        sitePrefixes.map(async (sp) => {
          const siteId = sp.slice(up.length, -1);
          if (siteId === exceptSiteId) return null; // skip the R2 GET for a meta the caller discards
          const meta = await getJson<SiteMeta>(b, sp + "_meta");
          return meta ? { username: u, siteId, meta } : null;
        }),
      );
    }),
  );
  return perUser.flat().filter((r): r is { username: string; siteId: string; meta: SiteMeta } => r !== null);
}

// R2 caps deletes at 1000 keys per call.
export async function deleteKeys(b: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await b.delete(keys.slice(i, i + 1000));
  }
}

// Derived from each site's _meta.bytes — there is no mutable usage counter.
export async function userUsage(b: R2Bucket, username: string, exceptSite?: string): Promise<number> {
  const metas = await listSiteMetas(b, username, exceptSite);
  return metas.reduce((total, { meta }) => total + (meta.bytes ?? 0), 0);
}

export async function deleteSite(b: R2Bucket, username: string, siteId: string): Promise<void> {
  const objs = await listAll(b, sitePrefix(username, siteId));
  await deleteKeys(b, objs.map((o) => o.key));
}

export async function listAssetMetas(b: R2Bucket, username?: string): Promise<AssetMeta[]> {
  const objs = await listAll(b, username ? userAssetsPrefix(username) : "_assets/");
  const metas = await Promise.all(
    objs.filter((o) => o.key.endsWith("/_meta")).map((o) => getJson<AssetMeta>(b, o.key)),
  );
  return metas.filter((m): m is AssetMeta => m !== null);
}

export async function assetUsage(b: R2Bucket, username: string): Promise<number> {
  const metas = await listAssetMetas(b, username);
  return metas.reduce((total, meta) => total + (meta.bytes ?? 0), 0);
}
