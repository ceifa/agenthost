// Nightly retention sweep. Delete sites whose last publish is older than their
// plan's retention window (retentionDays: null = infinite, never swept).

import type { Env } from "./env";
import { LIMITS } from "./config";
import { listUsers, listSiteMetas, deleteSite } from "./storage";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  checked: number;
  deleted: string[];
}

export async function runRetentionSweep(env: Env, now: number): Promise<SweepResult> {
  const planOf = new Map((await listUsers(env.SITES)).map(({ username, user }) => [username, user.plan]));

  const metas = await listSiteMetas(env.SITES);
  const deleted: string[] = [];

  for (const { username, siteId, meta } of metas) {
    const days = LIMITS[planOf.get(username) ?? "free"].retentionDays;
    if (days === null) continue;
    if (now - meta.lastDeployAt > days * DAY_MS) {
      await deleteSite(env.SITES, username, siteId);
      deleted.push(`${username}/${siteId}`);
    }
  }

  return { checked: metas.length, deleted };
}
