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

const USERS_PREFIX = "_users/";
const ASSETS_PREFIX = "_assets/";

export const siteFileKey = (u: string, s: string, path: string) => `sites/${u}/${s}/${path}`;
export const sitePrefix = (u: string, s: string) => `sites/${u}/${s}/`;
export const userSitesPrefix = (u: string) => `sites/${u}/`;
export const genKey = (u: string, s: string) => `sites/${u}/${s}/_gen`;
export const metaKey = (u: string, s: string) => `_sites/${u}/${s}`;
export const userMetaPrefix = (u: string) => `_sites/${u}/`;
export const legacyMetaKey = (u: string, s: string) => `sites/${u}/${s}/_meta`;
export const userKey = (u: string) => `${USERS_PREFIX}${u}`;
export const domainKey = (host: string) => `_domains/${host}`;
export const assetObjectKey = (u: string, id: string) => `assets/${u}/${id}/blob`;
export const assetMetaKey = (u: string, id: string) => `${ASSETS_PREFIX}${u}/${id}/_meta`;
const userAssetsPrefix = (u: string) => `${ASSETS_PREFIX}${u}/`;

// Control objects, never part of the served site.
export const isReservedFile = (path: string) => path === "_gen" || path === "_meta";

// ── layout hints ──
// These bounded hints choose a storage key, never cache access decisions. Every
// request still reads the current authoritative record. A legacy hint falls
// through after a publish migrates that site.
type Layout = "flat" | "legacy";
const locations = new WeakMap<R2Bucket, Map<string, Layout>>();
function locationMap(b: R2Bucket): Map<string, Layout> {
  let map = locations.get(b);
  if (!map) locations.set(b, map = new Map());
  return map;
}
function remember(b: R2Bucket, key: string, layout: Layout) {
  const map = locationMap(b);
  map.delete(key);
  map.set(key, layout);
  if (map.size > 1024) map.delete(map.keys().next().value!);
}

async function readLegacyGen(b: R2Bucket, u: string, s: string): Promise<number | null> {
  const obj = await b.get(genKey(u, s));
  if (!obj) return null;
  return Number.parseInt(await obj.text(), 10) || 0;
}

export async function getGen(b: R2Bucket, u: string, s: string): Promise<number> {
  const key = metaKey(u, s);
  if (locationMap(b).get(key) === "legacy") {
    const gen = await readLegacyGen(b, u, s);
    if (gen !== null) return gen;
  }
  const meta = await getJson<SiteMeta>(b, key);
  if (meta) {
    remember(b, key, "flat");
    return meta.generation ?? 0;
  }
  const gen = await readLegacyGen(b, u, s);
  if (gen === null) return 0;
  remember(b, key, "legacy");
  return gen;
}

// ── JSON records ──
// Small records ride in customMetadata.json (with an empty body), so a LIST
// with include: ["customMetadata"] reads a whole page of them without a GET.

function inlineJson<T>(obj: R2Object): T | null {
  const json = obj.customMetadata?.json;
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null; // old/corrupt projection: the caller falls back to the body
  }
}

async function getJson<T>(b: R2Bucket, key: string): Promise<T | null> {
  const obj = await b.get(key);
  if (!obj) return null;
  const inline = inlineJson<T>(obj);
  if (inline) {
    await obj.body.cancel();
    return inline;
  }
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

// A listed object's record, without a GET when the listing carried it inline.
async function listedJson<T>(b: R2Bucket, obj: R2Object): Promise<T | null> {
  return inlineJson<T>(obj) ?? getJson<T>(b, obj.key);
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

// ── listing ──

export interface RecordPage<T> { items: T[]; cursor?: string }
export interface SiteRecord { username: string; siteId: string; meta: SiteMeta }

// Walks a paged listing to the end, one page in memory at a time.
async function* paginate<T>(page: (cursor?: string) => Promise<RecordPage<T>>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const next = await page(cursor);
    yield* next.items;
    cursor = next.cursor;
  } while (cursor);
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
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

// One LIST page with inline metadata, each object mapped to a record (null drops it).
async function recordPage<T>(
  b: R2Bucket,
  opts: R2ListOptions,
  map: (obj: R2Object) => Promise<T | null>,
): Promise<RecordPage<T>> {
  const page = await b.list({ ...opts, limit: 1000, include: ["customMetadata"] });
  const records = await mapBounded(page.objects, map);
  return { items: records.filter((r): r is T => r !== null), cursor: page.truncated ? page.cursor : undefined };
}

export async function* objectPages(b: R2Bucket, prefix: string): AsyncGenerator<R2Object[]> {
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix, cursor, limit: 1000 });
    yield page.objects;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function listAll(b: R2Bucket, prefix: string): Promise<R2Object[]> {
  return (await collect(objectPages(b, prefix))).flat();
}

export function listUsersPage(b: R2Bucket, cursor?: string): Promise<RecordPage<{ username: string; user: UserRecord }>> {
  return recordPage(b, { prefix: USERS_PREFIX, cursor }, async obj => {
    const user = await listedJson<UserRecord>(b, obj);
    return user ? { username: obj.key.slice(USERS_PREFIX.length), user } : null;
  });
}

export function userRecords(b: R2Bucket): AsyncGenerator<{ username: string; user: UserRecord }> {
  return paginate(cursor => listUsersPage(b, cursor));
}

// Cursor phases let a mixed account enumerate flat records and its remaining
// legacy IDs without repeatedly listing uploaded files. Cursors are opaque to
// callers and validated before being passed to R2.
interface SiteCursor { phase: "flat" | "legacy"; cursor?: string; offset: number }

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

function decodeSiteCursor(value?: string): SiteCursor {
  if (!value) return { phase: "flat", offset: 0 };
  let parsed: Partial<SiteCursor> | null;
  try {
    parsed = JSON.parse(atob(value));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !parsed || typeof parsed !== "object" ||
    (parsed.phase !== "flat" && parsed.phase !== "legacy") ||
    !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0 ||
    (parsed.cursor !== undefined && typeof parsed.cursor !== "string")
  ) throw new InvalidCursorError();
  return parsed as SiteCursor;
}
const encodeSiteCursor = (phase: SiteCursor["phase"], cursor?: string, offset = 0) => btoa(JSON.stringify({ phase, cursor, offset }));

export async function listSitesPage(b: R2Bucket, username: string, user: UserRecord, cursor?: string, exceptSiteId?: string): Promise<RecordPage<SiteRecord>> {
  const state = decodeSiteCursor(cursor);
  const site = (siteId: string, meta: SiteMeta | null): SiteRecord | null => meta ? { username, siteId, meta } : null;

  // Unmigrated account: one "directory" per site under its file prefix.
  if (user.legacySiteIds === undefined) {
    const prefix = userSitesPrefix(username);
    const page = await b.list({ prefix, delimiter: "/", cursor: state.cursor, limit: 1000 });
    const siteIds = page.delimitedPrefixes.map(sp => sp.slice(prefix.length, -1)).filter(id => id !== exceptSiteId);
    // Files remain under this prefix after migration. Falling through to the
    // flat record also makes a failed catalog write recoverable on retry.
    const records = await mapBounded(siteIds, async id => site(id, await getMeta(b, username, id)));
    return { items: records.filter(r => r !== null), cursor: page.truncated ? encodeSiteCursor("legacy", page.cursor) : undefined };
  }

  if (state.phase === "legacy") {
    const ids = user.legacySiteIds.slice(state.offset, state.offset + 1000);
    const records = await mapBounded(ids.filter(id => id !== exceptSiteId), async id => site(id, await getJson<SiteMeta>(b, legacyMetaKey(username, id))));
    const offset = state.offset + ids.length;
    return { items: records.filter(r => r !== null), cursor: offset < user.legacySiteIds.length ? encodeSiteCursor("legacy", undefined, offset) : undefined };
  }

  const prefix = userMetaPrefix(username);
  const page = await recordPage(b, { prefix, cursor: state.cursor }, async obj => {
    const siteId = obj.key.slice(prefix.length);
    return siteId === exceptSiteId ? null : site(siteId, await listedJson<SiteMeta>(b, obj));
  });
  const next = page.cursor ? encodeSiteCursor("flat", page.cursor) : user.legacySiteIds.length ? encodeSiteCursor("legacy") : undefined;
  return { items: page.items, cursor: next };
}

export function siteRecords(b: R2Bucket, username: string, user: UserRecord, exceptSiteId?: string): AsyncGenerator<SiteRecord> {
  return paginate(cursor => listSitesPage(b, username, user, cursor, exceptSiteId));
}

export function listAssetsPage(b: R2Bucket, username?: string, cursor?: string): Promise<RecordPage<AssetMeta>> {
  return recordPage(b, { prefix: username ? userAssetsPrefix(username) : ASSETS_PREFIX, cursor }, async obj =>
    obj.key.endsWith("/_meta") ? listedJson<AssetMeta>(b, obj) : null);
}

// Every asset of one user — or, without a username, of all users in key order.
export function assetRecords(b: R2Bucket, username?: string): AsyncGenerator<AssetMeta> {
  return paginate(cursor => listAssetsPage(b, username, cursor));
}

export const listAssetMetas = (b: R2Bucket, username: string) => collect(assetRecords(b, username));

// ── usage & deletion ──
// Usage is derived from each record's bytes — there is no mutable counter.

export async function userUsage(b: R2Bucket, username: string, exceptSite?: string, account?: UserRecord): Promise<number> {
  const user = account ?? await getUser(b, username);
  if (!user) return 0;
  let total = 0;
  for await (const { meta } of siteRecords(b, username, user, exceptSite)) total += meta.bytes ?? 0;
  return total;
}

export async function assetUsage(b: R2Bucket, username: string): Promise<number> {
  let total = 0;
  for await (const meta of assetRecords(b, username)) total += meta.bytes ?? 0;
  return total;
}

// R2 caps deletes at 1000 keys per call.
export async function deleteKeys(b: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await b.delete(keys.slice(i, i + 1000));
  }
}

export async function deleteSite(b: R2Bucket, username: string, siteId: string): Promise<void> {
  for await (const objects of objectPages(b, sitePrefix(username, siteId))) {
    await deleteKeys(b, objects.map(o => o.key));
  }
  await b.delete(metaKey(username, siteId));
}
