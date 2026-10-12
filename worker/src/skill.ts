import { ASSET_LIMITS, LIMITS, formatBytes } from "./config";
import skillMd from "./skill/gen/SKILL";
import httpApiMd from "./skill/gen/http-api";

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`unknown template variable {{${name}}}`);
    return vars[name]!;
  });
}

const MARKDOWN = "text/markdown; charset=utf-8";

export const skillRoutes: Record<string, { template: string; contentType: string }> = {
  "/skill/SKILL.md": { template: skillMd, contentType: MARKDOWN },
  "/skill/references/http-api.md": { template: httpApiMd, contentType: MARKDOWN },
};

const retention = (days: number | null) => (days === null ? "infinite" : `${days} days`);

const limitVars = {
  freePerFile: formatBytes(LIMITS.free.perFile),
  freeFilesPerSite: String(LIMITS.free.filesPerSite),
  freePerSite: formatBytes(LIMITS.free.perSite),
  freePerUser: formatBytes(LIMITS.free.perUser),
  freeRetention: retention(LIMITS.free.retentionDays),
  freePerAsset: formatBytes(ASSET_LIMITS.free.perAsset),
  paidPerFile: formatBytes(LIMITS.paid.perFile),
  paidFilesPerSite: String(LIMITS.paid.filesPerSite),
  paidPerSite: formatBytes(LIMITS.paid.perSite),
  paidPerUser: formatBytes(LIMITS.paid.perUser),
  paidRetention: retention(LIMITS.paid.retentionDays),
  paidPerAsset: formatBytes(ASSET_LIMITS.paid.perAsset),
};

export const skillVars = (apexHost: string): Record<string, string> => ({ apexHost, ...limitVars });
