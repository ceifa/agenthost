// The agent skill from skills/agenthost, served under /skill/ so a self-hosted
// instance can hand its agents a copy that points at its own host. The text is
// written for agenthost.page; every mention of it becomes this deployment's apex.

import files from "./gen/skill";

const CANONICAL_HOST = "agenthost.page";

// path is relative to the skill directory, e.g. "SKILL.md" or
// "references/http-api.md". Returns null for anything that isn't a skill file.
export function skillFile(path: string, apexHost: string): string | null {
  if (!Object.hasOwn(files, path)) return null;
  return files[path]!.replaceAll(CANONICAL_HOST, apexHost.toLowerCase());
}
