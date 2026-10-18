// Nightly retention sweep. Delete sites whose last publish is older than their
// plan's retention window (retentionDays: null = infinite, never swept), then
// free accounts left with nothing once they are old enough.

import type { Env } from "./env";
import { LIMITS } from "./config";
import { assetMetaKey, assetRecords, deleteSite, listUsersPage, paginate, siteRecords, userKey, type AssetMeta } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;
// Long enough that an account mid-first-publish is never mistaken for an empty one.
const EMPTY_ACCOUNT_DAYS = 90;

export interface SweepResult {
  checked: number;
  deleted: string[];
  deletedCount: number;
}

export async function runRetentionSweep(env: Env, now: number): Promise<SweepResult> {
  const deleted: string[] = [];
  let checked = 0;
  let deletedCount = 0;
  const recordDelete = (name: string) => {
    deletedCount++;
    // Bound cron logs as well as the inventory. Counts still cover every item.
    if (deleted.length < 100) deleted.push(name);
  };
  const expireAsset = async (asset: AssetMeta, days: number | null) => {
    checked++;
    const expiredPending = asset.status === "pending" && now - asset.createdAt > DAY_MS;
    const expiredReady = days !== null && now - asset.lastDeployAt > days * DAY_MS;
    if (expiredPending || expiredReady) {
      await env.SITES.delete([asset.objectKey, assetMetaKey(asset.username, asset.id)]);
      recordDelete(`asset:${asset.username}/${asset.id}`);
      return true;
    }
    return false;
  };
  // Merge the two lexically ordered R2 inventories. This retains at most one
  // page from each, with no extra profile reads or per-user asset LISTs.
  const assets = assetRecords(env.SITES);
  let asset = await assets.next();
  for await (const { username, user } of paginate(cursor => listUsersPage(env.SITES, cursor))) {
    const days = LIMITS[user.plan].retentionDays;
    let kept = 0;
    while (!asset.done && asset.value.username <= username) {
      const own = asset.value.username === username;
      if (!(await expireAsset(asset.value, own ? days : LIMITS.free.retentionDays)) && own) kept++;
      asset = await assets.next();
    }
    for await (const { siteId, meta } of siteRecords(env.SITES, username)) {
      checked++;
      if (days !== null && now - meta.lastDeployAt > days * DAY_MS) {
        await deleteSite(env.SITES, username, siteId);
        recordDelete(`${username}/${siteId}`);
      } else {
        kept++;
      }
    }
    if (user.plan === "free" && kept === 0 && now - user.createdAt > EMPTY_ACCOUNT_DAYS * DAY_MS) {
      await env.SITES.delete(userKey(username));
      recordDelete(`user:${username}`);
    }
  }

  while (!asset.done) {
    await expireAsset(asset.value, LIMITS.free.retentionDays);
    asset = await assets.next();
  }

  // Every step is idempotent. A failed run can start again next cron without a
  // paid checkpoint PUT; cursors bound memory and deletes to a page at a time.
  return { checked, deleted, deletedCount };
}
