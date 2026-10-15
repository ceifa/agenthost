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

// The skill's files, by path inside the skill directory. Each is served under
// /skill/ and install.sh fetches every one, so a file added here gets installed.
export const skillFiles: Record<string, string> = {
  "SKILL.md": skillMd,
  "references/http-api.md": httpApiMd,
};

export const skillRoutes: Record<string, { template: string; contentType: string }> = {
  ...Object.fromEntries(Object.entries(skillFiles).map(([file, template]) => [`/skill/${file}`, { template, contentType: MARKDOWN }])),
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

export const credentialsFile = (apexHost: string) => `~/.config/agenthost/${apexHost}.curlrc`;

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// The token is read at a prompt with echo off, never typed on the command line,
// so it stays out of shell history.
export const credentialsCommand = (apexHost: string, username?: string) => {
  const user = username === undefined ? `printf '${apexHost} username: ' >&2; read -r u; ` : `u=${shellQuote(username)}; `;
  return `(f="$HOME/.config/agenthost/${apexHost}.curlrc"; mkdir -p "\${f%/*}" && umask 077 || exit; ${user}trap 'stty echo 2>/dev/null; exit 130' INT HUP TERM; stty -echo 2>/dev/null; printf '${apexHost} token (hidden): ' >&2; read -r t; stty echo 2>/dev/null; echo >&2; [ -n "$u" ] && [ -n "$t" ] || exit 1; printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' "$t" "$u" > "$f" && chmod 600 "$f" && echo "Saved $f" >&2)`;
};

export const writeCredentialsCommand = (apexHost: string) =>
  `mkdir -p ~/.config/agenthost && (umask 077 && printf 'header = "Authorization: Bearer %s"\\nheader = "x-agenthost-user: %s"\\n' 'OWNER_TOKEN' 'USERNAME' > ${credentialsFile(apexHost)}) && chmod 600 ${credentialsFile(apexHost)}`;

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
  skillFiles: Object.keys(skillFiles).join(" "),
  credentialsFile: credentialsFile(apexHost),
  credentialsCommand: credentialsCommand(apexHost),
  writeCredentialsCommand: writeCredentialsCommand(apexHost),
  ...limitVars,
});
