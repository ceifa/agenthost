// R2 key layout + typed accessors for the metadata objects. R2 is the only
// store; read-after-write is strongly consistent per object, which is what lets
// the publish→serve loop work without any other coordination primitive.

export interface SiteMeta {
  generation?: number; // absent on legacy nested records until republished
  createdAt: number;
  lastDeployAt: number;
  bytes: number;
  fileCount: number;
  keyHash: string | null; // sha256(accessKey); null only mid-first-publish
  public: boolean;
  tombstone?: boolean; // takedown marker → serve 410
}

export interface UserRecord {
  legacySiteIds?: string[]; // undefined = legacy inventory; [] = entirely flat
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
export const metaKey = (u: string, s: string) => `_sites/${u}/${s}`;
export const legacyMetaKey = (u: string, s: string) => `sites/${u}/${s}/_meta`;
export const userKey = (u: string) => `_users/${u}`;
export const domainKey = (host: string) => `_domains/${host}`;
export const assetObjectKey = (u: string, id: string) => `assets/${u}/${id}/blob`;
export const assetMetaKey = (u: string, id: string) => `_assets/${u}/${id}/_meta`;
export const userAssetsPrefix = (u: string) => `_assets/${u}/`;

// Control objects, never part of the served site.
export const RESERVED_FILE = (path: string) => path === "_gen" || path === "_meta";

// These bounded hints choose a storage key, never cache access decisions. Every
// request still reads the current authoritative record. A legacy hint falls
// through after a publish migrates that site.
const locations = new WeakMap<R2Bucket, Map<string, "flat" | "legacy">>();
function locationMap(b: R2Bucket): Map<string, "flat" | "legacy"> {
  let map = locations.get(b);
  if (!map) locations.set(b, map = new Map());
  return map;
}
function remember(b: R2Bucket, key: string, layout: "flat" | "legacy") {
  const map = locationMap(b);
  map.delete(key);
  map.set(key, layout);
  if (map.size > 1024) map.delete(map.keys().next().value!);
}

async function legacyGen(b: R2Bucket, u: string, s: string): Promise<number> {
  const obj = await b.get(genKey(u, s));
  if (!obj) return 0;
  remember(b, metaKey(u, s), "legacy");
  const n = parseInt(await obj.text(), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function getGen(b: R2Bucket, u: string, s: string): Promise<number> {
  const key = metaKey(u, s);
  if (locationMap(b).get(key) === "legacy") {
    const obj = await b.get(genKey(u, s));
    if (obj) return Number.parseInt(await obj.text(), 10) || 0;
  }
  const meta = await getJson<SiteMeta>(b, key);
  if (meta) {
    remember(b, key, "flat");
    return meta.generation ?? 0;
  }
  return legacyGen(b, u, s);
}

async function getJson<T>(b: R2Bucket, key: string): Promise<T | null> {
  const obj = await b.get(key);
  if (!obj) return null;
  if (obj.customMetadata?.json) {
    try {
      const value = JSON.parse(obj.customMetadata.json) as T;
      await obj.body.cancel();
      return value;
    } catch { /* tolerate an old/corrupt metadata projection with a valid body */ }
  }
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

async function putJson(b: R2Bucket, key: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  const inline = new TextEncoder().encode(encoded).byteLength <= 6000;
  await b.put(key, inline ? "" : encoded, {
    httpMetadata: { contentType: "application/json" },
    // No extra object or PUT. Large legacy catalogs fall back to a body GET.
    customMetadata: inline ? { json: encoded } : {},
  });
}

export async function getMeta(b: R2Bucket, u: string, s: string): Promise<SiteMeta | null> {
  const key = metaKey(u, s);
  const flat = locationMap(b).get(key) === "flat";
  const first = await getJson<SiteMeta>(b, flat ? key : legacyMetaKey(u, s));
  if (first) {
    remember(b, key, flat ? "flat" : "legacy");
    return first;
  }
  const second = await getJson<SiteMeta>(b, flat ? legacyMetaKey(u, s) : key);
  if (second) remember(b, key, flat ? "legacy" : "flat");
  return second;
}
export async function putMeta(b: R2Bucket, u: string, s: string, meta: SiteMeta): Promise<void> {
  // Owner/admin mutations of an unmigrated site retain its layout. Publishing
  // supplies generation and migrates the record after all file writes finish.
  const flat = meta.generation !== undefined;
  await putJson(b, flat ? metaKey(u, s) : legacyMetaKey(u, s), meta);
  remember(b, metaKey(u, s), flat ? "flat" : "legacy");
}
export const getUser = (b: R2Bucket, u: string) => getJson<UserRecord>(b, userKey(u));
export const putUser = (b: R2Bucket, u: string, rec: UserRecord) => putJson(b, userKey(u), rec);
export const getDomain = (b: R2Bucket, host: string) => getJson<DomainRecord>(b, domainKey(host));
export const putDomain = (b: R2Bucket, host: string, rec: DomainRecord) => putJson(b, domainKey(host), rec);
export const getAssetMeta = (b: R2Bucket, u: string, id: string) => getJson<AssetMeta>(b, assetMetaKey(u, id));
export const putAssetMeta = (b: R2Bucket, u: string, id: string, meta: AssetMeta) => putJson(b, assetMetaKey(u, id), meta);

// R2's current API supports include, even though the pinned types predate it.
export type MetadataListOptions = R2ListOptions & { include?: ("customMetadata" | "httpMetadata")[] };
export async function* objectPages(b: R2Bucket, prefix: string, opts?: MetadataListOptions): AsyncGenerator<R2Objects> {
  let cursor = opts?.cursor;
  do {
    const page = await b.list({ ...opts, prefix, cursor, limit: opts?.limit ?? 1000 });
    yield page;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function indexedJson<T>(b: R2Bucket, obj: R2Object): Promise<T | null> {
  const json = obj.customMetadata?.json;
  if (json) {
    try { return JSON.parse(json) as T; } catch { /* old/corrupt index: read body */ }
  }
  return getJson<T>(b, obj.key);
}

// Bound fallback reads for pre-indexed objects; a wide account cannot open
// thousands of R2 connections or promises at once.
export async function mapBounded<T, U>(items: T[], map: (item: T) => Promise<U>, concurrency = 3): Promise<U[]> {
  const result = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      result[i] = await map(items[i]!);
    }
  }));
  return result;
}

// Follows pagination cursors to return every key under a prefix.
export async function listAll(b: R2Bucket, prefix: string, opts?: MetadataListOptions): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const res = await b.list({ ...opts, prefix, cursor, limit: 1000 });
    out.push(...res.objects);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

export interface RecordPage<T> { items: T[]; cursor?: string }
export interface SiteRecord { username: string; siteId: string; meta: SiteMeta }

export async function listUsersPage(b: R2Bucket, cursor?: string): Promise<RecordPage<{ username: string; user: UserRecord }>> {
  const page = await b.list({ prefix: "_users/", cursor, limit: 1000, include: ["customMetadata"] } as MetadataListOptions);
  const records = await mapBounded(page.objects, async obj => {
    const user = await indexedJson<UserRecord>(b, obj);
    return user ? { username: obj.key.slice("_users/".length), user } : null;
  });
  return { items: records.filter((r): r is { username: string; user: UserRecord } => r !== null), cursor: page.truncated ? page.cursor : undefined };
}

// Cursor phases let a mixed account enumerate flat records and its remaining
// legacy IDs without repeatedly listing uploaded files. Cursors are opaque to
// callers and validated before being passed to R2.
function siteCursor(value?: string): { phase: "flat" | "legacy"; cursor?: string; offset: number } {
  if (!value) return { phase: "flat", offset: 0 };
  const parsed = JSON.parse(atob(value)) as { phase: string; cursor?: string; offset: number };
  if (!parsed || typeof parsed !== "object" || (parsed.phase !== "flat" && parsed.phase !== "legacy") || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || (parsed.cursor !== undefined && typeof parsed.cursor !== "string")) throw new Error("invalid cursor");
  return parsed as { phase: "flat" | "legacy"; cursor?: string; offset: number };
}
const encodeSiteCursor = (phase: "flat" | "legacy", cursor?: string, offset = 0) => btoa(JSON.stringify({ phase, cursor, offset }));

export async function listSitesPage(b: R2Bucket, username: string, user: UserRecord, cursor?: string, exceptSiteId?: string): Promise<RecordPage<SiteRecord>> {
  const state = siteCursor(cursor);
  if (user.legacySiteIds === undefined) {
    const prefix = userSitesPrefix(username);
    const page = await b.list({ prefix, delimiter: "/", cursor: state.cursor, limit: 1000 });
    const records = await mapBounded(page.delimitedPrefixes.filter(sp => sp.slice(prefix.length, -1) !== exceptSiteId), async sp => {
      // Files remain under this prefix after migration. Falling through to the
      // flat record also makes a failed catalog write recoverable on retry.
      const meta = await getMeta(b, username, sp.slice(prefix.length, -1));
      return meta ? { username, siteId: sp.slice(prefix.length, -1), meta } : null;
    });
    return { items: records.filter((r): r is SiteRecord => r !== null), cursor: page.truncated ? encodeSiteCursor("legacy", page.cursor) : undefined };
  }
  if (state.phase === "legacy") {
    const ids = user.legacySiteIds.slice(state.offset, state.offset + 1000);
    const records = await mapBounded(ids.filter(id => id !== exceptSiteId), async siteId => {
      const meta = await getJson<SiteMeta>(b, legacyMetaKey(username, siteId));
      return meta ? { username, siteId, meta } : null;
    });
    const offset = state.offset + ids.length;
    return { items: records.filter((r): r is SiteRecord => r !== null), cursor: offset < user.legacySiteIds.length ? encodeSiteCursor("legacy", undefined, offset) : undefined };
  }
  const prefix = `_sites/${username}/`;
  const page = await b.list({ prefix, cursor: state.cursor, limit: 1000, include: ["customMetadata"] } as MetadataListOptions);
  const records = await mapBounded(page.objects.filter(obj => obj.key.slice(prefix.length) !== exceptSiteId), async obj => {
    const meta = await indexedJson<SiteMeta>(b, obj);
    return meta ? { username, siteId: obj.key.slice(prefix.length), meta } : null;
  });
  const next = page.truncated ? encodeSiteCursor("flat", page.cursor) : user.legacySiteIds.length ? encodeSiteCursor("legacy") : undefined;
  return { items: records.filter((r): r is SiteRecord => r !== null), cursor: next };
}

export async function* siteRecords(b: R2Bucket, username: string, user: UserRecord, exceptSiteId?: string): AsyncGenerator<SiteRecord> {
  let cursor: string | undefined;
  do {
    const page = await listSitesPage(b, username, user, cursor, exceptSiteId);
    yield* page.items;
    cursor = page.cursor;
  } while (cursor);
}

// R2 caps deletes at 1000 keys per call.
export async function deleteKeys(b: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await b.delete(keys.slice(i, i + 1000));
  }
}

// Derived from each site's _meta.bytes — there is no mutable usage counter.
export async function userUsage(b: R2Bucket, username: string, exceptSite?: string, account?: UserRecord): Promise<number> {
  const user = account ?? await getUser(b, username);
  if (!user) return 0;
  let total = 0;
  for await (const { meta } of siteRecords(b, username, user, exceptSite)) total += meta.bytes ?? 0;
  return total;
}

export async function deleteSite(b: R2Bucket, username: string, siteId: string): Promise<void> {
  for await (const page of objectPages(b, sitePrefix(username, siteId))) {
    await deleteKeys(b, page.objects.map(o => o.key));
  }
  await b.delete(metaKey(username, siteId));
}

export async function listAssetsPage(b: R2Bucket, username?: string, cursor?: string): Promise<RecordPage<AssetMeta>> {
  const page = await b.list({ prefix: username ? userAssetsPrefix(username) : "_assets/", cursor, limit: 1000, include: ["customMetadata"] } as MetadataListOptions);
  const records = await mapBounded(page.objects.filter(obj => obj.key.endsWith("/_meta")), obj => indexedJson<AssetMeta>(b, obj));
  return { items: records.filter((r): r is AssetMeta => r !== null), cursor: page.truncated ? page.cursor : undefined };
}

export async function listAssetMetas(b: R2Bucket, username?: string): Promise<AssetMeta[]> {
  const result: AssetMeta[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAssetsPage(b, username, cursor);
    result.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return result;
}

export async function assetUsage(b: R2Bucket, username: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await listAssetsPage(b, username, cursor);
    for (const meta of page.items) total += meta.bytes ?? 0;
    cursor = page.cursor;
  } while (cursor);
  return total;
}
