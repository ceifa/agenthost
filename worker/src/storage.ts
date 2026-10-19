// R2 key layout + typed accessors for the metadata objects. R2 is the only
// store; read-after-write is strongly consistent per object, which is what lets
// the publish→serve loop work without any other coordination primitive.

// A share: one tree of files on its own subdomain. The access key is stored as
// is: it is meant to travel in URLs, and anyone who can read this record can
// read the files it guards.
export interface SiteMeta {
  generation: number;
  createdAt: number;
  lastDeployAt: number;
  bytes: number;
  fileCount: number;
  accessKey?: string;
  keyHash?: string; // sha256 of a key minted before keys were stored; gone on rotate
  public: boolean;
  tombstone?: boolean; // takedown marker → serve 410
  // Presigned uploads not yet completed, by path. Their bytes count against
  // the quota until completed or swept.
  pending?: Record<string, { bytes: number; expiresAt: number }>;
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

export const siteFileKey = (u: string, s: string, path: string) => `sites/${u}/${s}/${path}`;
export const sitePrefix = (u: string, s: string) => `sites/${u}/${s}/`;
export const userSitesPrefix = (u: string) => `sites/${u}/`;
export const metaKey = (u: string, s: string) => `_sites/${u}/${s}`;
export const userKey = (u: string) => `_users/${u}`;
// An empty object whose upload time is the share's last visit. Kept apart from
// the share record so a visit never races a publish's read-modify-write.
export const visitKey = (u: string, s: string) => `_visits/${u}/${s}`;
export const domainKey = (host: string) => `_domains/${host}`;

// The live-reload probe answers /_gen, so a published file there could never be served.
export const RESERVED_FILE = (path: string) => path === "_gen";

// Every control record keeps its JSON in customMetadata with an empty body, so
// a LIST with include: ["customMetadata"] returns whole records.
async function getJson<T>(b: R2Bucket, key: string): Promise<T | null> {
  const obj = await b.get(key);
  if (!obj) return null;
  await obj.body.cancel();
  const json = obj.customMetadata?.json;
  return json ? JSON.parse(json) as T : null;
}

async function putJson(b: R2Bucket, key: string, value: unknown): Promise<void> {
  await b.put(key, "", {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { json: JSON.stringify(value) },
  });
}

export const getMeta = (b: R2Bucket, u: string, s: string) => getJson<SiteMeta>(b, metaKey(u, s));
export const putMeta = (b: R2Bucket, u: string, s: string, meta: SiteMeta) => putJson(b, metaKey(u, s), meta);
export const getUser = (b: R2Bucket, u: string) => getJson<UserRecord>(b, userKey(u));
export const putUser = (b: R2Bucket, u: string, rec: UserRecord) => putJson(b, userKey(u), rec);
export const getDomain = (b: R2Bucket, host: string) => getJson<DomainRecord>(b, domainKey(host));
export const putDomain = (b: R2Bucket, host: string, rec: DomainRecord) => putJson(b, domainKey(host), rec);

export async function* objectPages(b: R2Bucket, prefix: string): AsyncGenerator<R2Objects> {
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix, cursor, limit: 1000 });
    yield page;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// Every record of a paged listing, one page in memory at a time.
export async function* paginate<T>(page: (cursor?: string) => Promise<RecordPage<T>>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const next = await page(cursor);
    yield* next.items;
    cursor = next.cursor;
  } while (cursor);
}

// A listed record, from the customMetadata the LIST was asked to include.
function listed<T>(obj: R2Object): T | null {
  const json = obj.customMetadata?.json;
  return json ? JSON.parse(json) as T : null;
}

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

export async function listAll(b: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  for await (const page of objectPages(b, prefix)) out.push(...page.objects);
  return out;
}

export interface RecordPage<T> { items: T[]; cursor?: string }
export interface SiteRecord { username: string; siteId: string; meta: SiteMeta }

// One LIST per page of up to 1000 records, from `_{kind}/` keys that each hold
// their JSON in customMetadata.
async function recordPage<T>(b: R2Bucket, prefix: string, cursor: string | undefined, record: (obj: R2Object) => T | null): Promise<RecordPage<T>> {
  const page = await b.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
  const items = page.objects.map(record).filter((r): r is T => r !== null);
  return { items, cursor: page.truncated ? page.cursor : undefined };
}

export const listUsersPage = (b: R2Bucket, cursor?: string) => recordPage(b, "_users/", cursor, obj => {
  const user = listed<UserRecord>(obj);
  return user && { username: obj.key.slice("_users/".length), user };
});

// Which of `usernames` (one users page, in key order) own any share files. A delimited LIST names up to 1000 owners per
// call, so a page costs one LIST per thousand owners instead of one per account.
export async function owners(b: R2Bucket, usernames: string[]): Promise<Set<string>> {
  const root = "sites/";
  const owners = new Set<string>();
  const first = usernames[0], last = usernames.at(-1);
  if (first === undefined || last === undefined) return owners;
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix: root, delimiter: "/", limit: 1000, ...(cursor ? { cursor } : { startAfter: root + first }) });
    for (const prefix of page.delimitedPrefixes) {
      const owner = prefix.slice(root.length, -1);
      if (owner > last) return owners;
      owners.add(owner);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return owners;
}

export const listSitesPage = (b: R2Bucket, username: string, cursor?: string, exceptSiteId?: string) => recordPage(b, `_sites/${username}/`, cursor, obj => {
  const siteId = obj.key.slice(`_sites/${username}/`.length);
  const meta = siteId === exceptSiteId ? null : listed<SiteMeta>(obj);
  return meta && { username, siteId, meta };
});

export const siteRecords = (b: R2Bucket, username: string, exceptSiteId?: string) =>
  paginate(cursor => listSitesPage(b, username, cursor, exceptSiteId));

// R2 caps deletes at 1000 keys per call.
export async function deleteKeys(b: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await b.delete(keys.slice(i, i + 1000));
  }
}

// A share's committed files out of a LIST of its prefix: uploads still in flight
// land on their final key before they're completed, and don't count yet.
export function committedFiles(objects: R2Object[], username: string, siteId: string, meta: SiteMeta | null): R2Object[] {
  const pending = new Set(Object.keys(meta?.pending ?? {}).map(p => siteFileKey(username, siteId, p)));
  return objects.filter(o => !pending.has(o.key));
}

// Stored bytes plus uploads still reserved.
export function shareUsage(meta: SiteMeta): number {
  let total = meta.bytes ?? 0;
  for (const { bytes } of Object.values(meta.pending ?? {})) total += bytes;
  return total;
}

// Derived from each share's record — there is no mutable usage counter.
export async function userUsage(b: R2Bucket, username: string, exceptSite?: string): Promise<number> {
  let total = 0;
  for await (const { meta } of siteRecords(b, username, exceptSite)) total += shareUsage(meta);
  return total;
}

export async function deleteSite(b: R2Bucket, username: string, siteId: string): Promise<void> {
  for await (const page of objectPages(b, sitePrefix(username, siteId))) {
    await deleteKeys(b, page.objects.map(o => o.key));
  }
  await b.delete([metaKey(username, siteId), visitKey(username, siteId)]);
}

// When each of a user's shares was last visited, by share id.
export async function lastVisits(b: R2Bucket, username: string): Promise<Map<string, number>> {
  const prefix = `_visits/${username}/`;
  return new Map((await listAll(b, prefix)).map(o => [o.key.slice(prefix.length), o.uploaded.getTime()]));
}
