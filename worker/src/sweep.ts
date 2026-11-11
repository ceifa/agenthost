// Nightly retention sweep. Delete shares neither changed nor visited within their
// plan's retention window, drop uploads never completed, then free accounts left
// with nothing once they are old enough. Then delete files no share record
// points at.
//
// It reads three flat listings side by side: accounts, share records and visits,
// a thousand rows per LIST. They come back in key order, which groups the last
// two by owner in the same order as the accounts, so one pass joins them with one
// account's rows in memory. (It used to make two LISTs per account. Every
// anonymous publish is an account, so that passed the subrequest limit at a few
// thousand of them, and a run that dies restarts from the top: accounts late in
// the alphabet were never reached again.)

import type { Env } from "./env";
import { LIMITS, ORPHAN_GRACE_MS, SWEEP } from "./config";
import { allFiles, allSiteRecords, allVisits, deleteKeys, deleteSite, listUsersPage, paginate, siteFileKey, updateMeta, userKey, type SiteMeta } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;
// Long enough that an account mid-first-publish is never mistaken for an empty one.
const EMPTY_ACCOUNT_DAYS = 90;

// The join relies on `_users/{u}` and `_sites/{u}/…` sorting accounts the same
// way. That holds for the usernames we mint and accept ([a-z0-9]): every such
// character sorts after "/". A row owned by any other name is left alone.
const PLAIN_USERNAME = /^[a-z0-9]+$/;

export interface SweepResult {
  checked: number;
  deleted: string[];
  deletedCount: number;
  ops: number; // R2 operations spent
  complete: boolean; // false: the budget ran out and the next run carries on
  unowned: number; // share and visit rows whose account record is gone; left alone
  orphans: number; // files under no share record, deleted
}

// Hands out one owner's rows at a time from a listing sorted by owner.
class ByOwner<T extends { username: string }> {
  private next: Promise<IteratorResult<T>> | null = null;
  skipped = 0;
  constructor(private readonly rows: AsyncIterator<T>) {}

  // The rows of `username`, after passing over every owner sorted before it.
  async take(username: string): Promise<T[]> {
    const mine: T[] = [];
    for (;;) {
      const row = await (this.next ??= this.rows.next());
      if (row.done || row.value.username > username) return mine;
      this.next = null;
      if (row.value.username === username) mine.push(row.value);
      else this.skipped++;
    }
  }
}

async function* plainOnly<T extends { username: string }>(rows: AsyncIterable<T>, onSkip: () => void): AsyncGenerator<T> {
  for await (const row of rows) {
    if (PLAIN_USERNAME.test(row.username)) yield row;
    else onSkip();
  }
}

// Counts every call made through the bucket, so the run knows what it has spent.
function counted(bucket: R2Bucket): { bucket: R2Bucket; spent: () => number } {
  let ops = 0;
  const proxy = new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        ops++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket: proxy, spent: () => ops };
}

const expiredUploads = (meta: SiteMeta, now: number) =>
  Object.entries(meta.pending ?? {}).filter(([, p]) => p.expiresAt < now).map(([path]) => path);

// Files with no share record: a first publish that failed or was cut off after
// writing them, a presigned URL used after its share was deleted, a delete that
// died halfway. No quota counts them and no share's retention reaches them, so
// nothing else would ever remove them. Walks every file next to every share
// record, both grouped by owner in the same order, holding one account's share
// ids at a time. False if the budget ran out first.
async function deleteOrphanFiles(bucket: R2Bucket, now: number, exhausted: () => boolean, found: (key: string) => void): Promise<boolean> {
  const records = new ByOwner(plainOnly(allSiteRecords(bucket), () => {}));
  let owner: string | null = null;
  let shareIds = new Set<string>();
  let doomed: string[] = [];
  const flush = async () => {
    const keys = doomed;
    doomed = [];
    await deleteKeys(bucket, keys);
  };
  for await (const file of plainOnly(allFiles(bucket), () => {})) {
    if (file.username !== owner) {
      if (exhausted()) {
        await flush();
        return false;
      }
      owner = file.username;
      shareIds = new Set((await records.take(owner)).map(r => r.siteId));
    }
    if (shareIds.has(file.siteId) || now - file.at <= ORPHAN_GRACE_MS) continue;
    found(file.key);
    doomed.push(file.key);
    if (doomed.length === 1000) await flush();
  }
  await flush();
  return true;
}

export async function runRetentionSweep(env: Env, now: number, budget = SWEEP): Promise<SweepResult> {
  const { bucket, spent } = counted(env.SITES);
  const started = Date.now();
  const exhausted = () => spent() >= budget.maxOps || Date.now() - started >= budget.maxMs;

  const deleted: string[] = [];
  let checked = 0;
  let deletedCount = 0;
  let oddlyNamed = 0;
  let orphans = 0;
  const recordDelete = (name: string) => {
    deletedCount++;
    // Bound cron logs as well as the inventory. Counts still cover every item.
    if (deleted.length < 100) deleted.push(name);
  };
  const shares = new ByOwner(plainOnly(allSiteRecords(bucket), () => oddlyNamed++));
  const visits = new ByOwner(plainOnly(allVisits(bucket), () => oddlyNamed++));
  const result = (complete: boolean): SweepResult => ({
    checked, deleted, deletedCount, ops: spent(), complete, unowned: shares.skipped + visits.skipped + oddlyNamed, orphans,
  });

  for await (const { username, user } of paginate(cursor => listUsersPage(bucket, cursor))) {
    if (!PLAIN_USERNAME.test(username)) continue;
    const days = LIMITS[user.plan].retentionDays;
    const visited = new Map((await visits.take(username)).map(v => [v.siteId, v.at]));
    let kept = 0;
    for (const { siteId, meta } of await shares.take(username)) {
      // Stop between shares: everything done so far is complete, and the account
      // is not judged empty on a half-read list.
      if (exhausted()) return result(false);
      checked++;
      const lastActive = Math.max(meta.lastDeployAt, visited.get(siteId) ?? 0);
      if (now - lastActive > days * DAY_MS) {
        await deleteSite(bucket, username, siteId);
        recordDelete(`${username}/${siteId}`);
        continue;
      }
      kept++;
      // An abandoned upload may still have landed at its path: delete both.
      const expired = expiredUploads(meta, now);
      if (expired.length) {
        await bucket.delete(expired.map(path => siteFileKey(username, siteId, path)));
        for (const path of expired) recordDelete(`upload:${username}/${siteId}/${path}`);
        // Against the record as it is now: the listing above is a snapshot, and a
        // path reserved again since then keeps its new reservation.
        await updateMeta(bucket, username, siteId, current => {
          if (!current) return null;
          const pending = { ...current.pending };
          for (const path of expired) if (pending[path] && pending[path].expiresAt < now) delete pending[path];
          return { ...current, pending };
        });
      }
    }
    if (user.plan === "free" && kept === 0 && now - user.createdAt > EMPTY_ACCOUNT_DAYS * DAY_MS) {
      await bucket.delete(userKey(username));
      recordDelete(`user:${username}`);
    }
    if (exhausted()) return result(false);
  }

  // After retention, so files of a share deleted above are already gone.
  const swept = await deleteOrphanFiles(bucket, now, exhausted, key => {
    orphans++;
    if (deleted.length < 100) deleted.push(`orphan:${key.slice("sites/".length)}`);
  });

  // Every step is idempotent, and what a run deletes is gone, so a run cut short
  // needs no checkpoint: the next one pays for the listing and carries on.
  return result(swept);
}
