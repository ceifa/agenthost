// Nightly retention sweep. Delete shares whose last publish is older than their
// plan's retention window (retentionDays: null = infinite, never swept), reconcile
// direct uploads, then free accounts left with nothing once they are
// old enough.

import type { Env } from "./env";
import { LIMITS } from "./config";
import { deleteSite, listUsersPage, paginate, reconcileUploads, siteRecords, userKey } from "./storage";

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
  for await (const { username, user } of paginate(cursor => listUsersPage(env.SITES, cursor))) {
    const days = LIMITS[user.plan].retentionDays;
    let kept = 0;
    for await (const { siteId, meta: record } of siteRecords(env.SITES, username)) {
      const meta = await reconcileUploads(env.SITES, username, siteId, record, now);
      checked++;
      if (days !== null && now - meta.lastDeployAt > days * DAY_MS) {
        await deleteSite(env.SITES, username, siteId);
        recordDelete(`${username}/${siteId}`);
        continue;
      }
      kept++;
    }
    if (user.plan === "free" && kept === 0 && now - user.createdAt > EMPTY_ACCOUNT_DAYS * DAY_MS) {
      await env.SITES.delete(userKey(username));
      recordDelete(`user:${username}`);
    }
  }

  // Every step is idempotent. A failed run can start again next cron without a
  // paid checkpoint PUT; cursors bound memory and deletes to a page at a time.
  return { checked, deleted, deletedCount };
}
