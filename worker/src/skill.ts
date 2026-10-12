import { ASSET_LIMITS, LIMITS, formatBytes } from "./config";
import type { Env } from "./env";
import skillMd from "./skill/gen/SKILL";
import httpApiMd from "./skill/gen/http-api";
import installSh from "./skill/gen/install";

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
  "/skill/install.sh": { template: installSh, contentType: "text/plain; charset=utf-8" },
};

// The Agent Skills spec's name rule. A name that breaks it makes the skill
// invalid, so a bad SKILL_NAME fails the request instead of serving one.
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function skillName(env: Pick<Env, "APEX_HOST" | "SKILL_NAME">): { ok: true; name: string } | { ok: false; error: string } {
  const name = env.SKILL_NAME ?? env.APEX_HOST.toLowerCase().replaceAll(".", "-");
  if (name.length <= 64 && SKILL_NAME_RE.test(name)) return { ok: true, name };
  return {
    ok: false,
    error: `skill name "${name}" is not a valid Agent Skill name (lowercase letters, digits and single hyphens, at most 64 characters); set SKILL_NAME`,
  };
}

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

export const skillVars = (apexHost: string, skillName: string): Record<string, string> => ({
  apexHost,
  skillName,
  ...limitVars,
});
