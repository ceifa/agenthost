// R2 key layout + typed accessors for the metadata objects. R2 is the only
// store; read-after-write is strongly consistent per object, which is what lets
// the publish→serve loop work without any other coordination primitive.

// A share: one tree of files on its own subdomain. Written only through
// updateMeta, never as a plain put. The access key is stored as
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
  createdAt: number;
  suspended?: boolean; // set by the admin: the owner token is refused
}

export const siteFileKey = (u: string, s: string, path: string) => `sites/${u}/${s}/${path}`;
export const sitePrefix = (u: string, s: string) => `sites/${u}/${s}/`;
export const userSitesPrefix = (u: string) => `sites/${u}/`;
export const metaKey = (u: string, s: string) => `_sites/${u}/${s}`;
export const userKey = (u: string) => `_users/${u}`;
// An empty object whose upload time is the share's last visit. Kept apart from
// the share record so a visit never races a publish's read-modify-write.
export const visitKey = (u: string, s: string) => `_visits/${u}/${s}`;

// The live-reload probe answers /_gen, so a published file there could never be served.
export const RESERVED_FILE = (path: string) => path === "_gen";

// Every control record keeps its JSON in customMetadata, so a LIST with
// include: ["customMetadata"] returns whole records. R2 derives an object's etag
// from its body, so the body is a fresh stamp on every write: two versions of a
// record never share an etag, which is what lets a write be conditional on the
// version it read. (Records written before this have an empty body and all share
// one etag; the first write stamps them.)
async function getJson<T>(b: R2Bucket, key: string): Promise<T | null> {
  const obj = await b.get(key);
  if (!obj) return null;
  await obj.body.cancel();
  const json = obj.customMetadata?.json;
  return json ? JSON.parse(json) as T : null;
}

// False when `onlyIf` no longer holds: someone else wrote the record first.
async function putJson(b: R2Bucket, key: string, value: unknown, onlyIf?: R2Conditional): Promise<boolean> {
  const stored = await b.put(key, crypto.randomUUID(), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { json: JSON.stringify(value) },
    onlyIf,
  });
  return stored !== null;
}

export const getMeta = (b: R2Bucket, u: string, s: string) => getJson<SiteMeta>(b, metaKey(u, s));

// A share record with the etag of the version it was read at; etag null when
// there is no record at all.
export interface MetaVersion { meta: SiteMeta | null; etag: string | null }
export const NO_RECORD: MetaVersion = { meta: null, etag: null };

function metaVersion(obj: R2Object | null): MetaVersion {
  if (!obj) return NO_RECORD;
  const json = obj.customMetadata?.json;
  return { meta: json ? JSON.parse(json) as SiteMeta : null, etag: obj.etag };
}

// getMeta, keeping the version so a later updateMeta can skip reading it again.
export async function readMeta(b: R2Bucket, u: string, s: string): Promise<MetaVersion> {
  const obj = await b.get(metaKey(u, s));
  await obj?.body.cancel();
  return metaVersion(obj);
}
export const getUser = (b: R2Bucket, u: string) => getJson<UserRecord>(b, userKey(u));
export const putUser = async (b: R2Bucket, u: string, rec: UserRecord): Promise<void> => { await putJson(b, userKey(u), rec); };

// Thrown when a share record changed under every attempt to update it.
export class RecordBusyError extends Error {
  constructor(username: string, siteId: string) {
    super(`share ${username}/${siteId} is being changed by other requests; retry`);
    this.name = "RecordBusyError";
  }
}

const UPDATE_ATTEMPTS = 6;

// The only way to write a share record. `change` gets the record as it is now
// (null if there is none) and returns the record to store, or null to leave it
// alone. The write is conditional on the version `change` saw, and a lost race
// reads again and re-applies `change`, so a writer never overwrites what another
// committed in between: a publish that streamed for a minute cannot bring back
// the key that was rotated, or lift the takedown that landed, while it ran.
// `change` may run more than once; it must derive everything from its argument.
//
// `seen` is a version the caller already read (readMeta). The first attempt
// writes against it instead of reading the record again, which saves a round
// trip when nothing changed in between; if something did, the conditional write
// fails and the loop carries on from a fresh read, exactly as without it.
export async function updateMeta(
  b: R2Bucket,
  u: string,
  s: string,
  change: (current: SiteMeta | null) => SiteMeta | null | Promise<SiteMeta | null>,
  seen?: MetaVersion,
): Promise<SiteMeta | null> {
  const key = metaKey(u, s);
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
    const trusted = attempt === 0 && seen !== undefined;
    const current = trusted ? seen : metaVersion(await b.head(key));
    const next = await change(current.meta);
    if (!next) {
      // "Leave it alone" has to be decided on the record as it is now.
      if (trusted) continue;
      return null;
    }
    if (await putJson(b, key, next, current.etag !== null ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" })) return next;
  }
  throw new RecordBusyError(u, s);
}

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

// `{username}/{siteId}` after a control prefix. Neither part contains a slash.
function ownerAndShare(key: string, prefix: string): { username: string; siteId: string } | null {
  const slash = key.indexOf("/", prefix.length);
  return slash < 0 ? null : { username: key.slice(prefix.length, slash), siteId: key.slice(slash + 1) };
}

// Every share record of every account, in key order: a thousand per LIST, so
// the nightly sweep costs a call per thousand shares instead of calls per account.
export const allSiteRecords = (b: R2Bucket): AsyncGenerator<SiteRecord> => paginate(cursor => recordPage(b, "_sites/", cursor, obj => {
  const id = ownerAndShare(obj.key, "_sites/");
  const meta = listed<SiteMeta>(obj);
  return id && meta && { ...id, meta };
}));

export interface FileRow { username: string; siteId: string; key: string; at: number }

// Every stored file of every share, in the same order.
export async function* allFiles(b: R2Bucket): AsyncGenerator<FileRow> {
  for await (const page of objectPages(b, "sites/")) {
    for (const obj of page.objects) {
      const id = ownerAndShare(obj.key, "sites/");
      const slash = id ? id.siteId.indexOf("/") : -1;
      if (id && slash > 0) yield { username: id.username, siteId: id.siteId.slice(0, slash), key: obj.key, at: obj.uploaded.getTime() };
    }
  }
}

export interface VisitRecord { username: string; siteId: string; at: number }

// When every share was last visited, in the same order.
export async function* allVisits(b: R2Bucket): AsyncGenerator<VisitRecord> {
  for await (const page of objectPages(b, "_visits/")) {
    for (const obj of page.objects) {
      const id = ownerAndShare(obj.key, "_visits/");
      if (id) yield { ...id, at: obj.uploaded.getTime() };
    }
  }
}
