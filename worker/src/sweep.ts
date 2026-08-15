// Nightly retention sweep. Delete sites whose last publish is older than their
// plan's retention window (retentionDays: null = infinite, never swept).

import type { Env } from "./env";
import { LIMITS } from "./config";
import { assetMetaKey, listAssetMetas, listUsers, listSiteMetas, deleteSite } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  checked: number;
  deleted: string[];
}

export async function runRetentionSweep(env: Env, now: number): Promise<SweepResult> {
  const planOf = new Map((await listUsers(env.SITES)).map(({ username, user }) => [username, user.plan]));

  const [metas, assets] = await Promise.all([listSiteMetas(env.SITES), listAssetMetas(env.SITES)]);
  const deleted: string[] = [];

  for (const { username, siteId, meta } of metas) {
    const days = LIMITS[planOf.get(username) ?? "free"].retentionDays;
    if (days === null) continue;
    if (now - meta.lastDeployAt > days * DAY_MS) {
      await deleteSite(env.SITES, username, siteId);
      deleted.push(`${username}/${siteId}`);
    }
  }

  for (const asset of assets) {
    const days = LIMITS[planOf.get(asset.username) ?? "free"].retentionDays;
    // Failed/abandoned direct uploads should not reserve quota until the normal
    // retention window; one day is ample for a 5 GB signed PUT.
    const expiredPending = asset.status === "pending" && now - asset.createdAt > DAY_MS;
    const expiredReady = days !== null && now - asset.lastDeployAt > days * DAY_MS;
    if (expiredPending || expiredReady) {
      await Promise.all([
        env.SITES.delete(asset.objectKey),
        env.SITES.delete(assetMetaKey(asset.username, asset.id)),
      ]);
      deleted.push(`asset:${asset.username}/${asset.id}`);
    }
  }

  return { checked: metas.length + assets.length, deleted };
}
