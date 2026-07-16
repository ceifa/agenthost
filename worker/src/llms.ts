// /llms.txt — machine-readable publish instructions served at the apex.
// The apex host is read from env (APEX_HOST) so the text always reflects the
// deployment, and limits are rendered from config so a quota bump can't silently
// make this lie.

import { LIMITS, MB } from "./config";

const free = LIMITS.free;
const mb = (bytes: number) => `${Math.round(bytes / MB)} MB`;

export const llmsTxt = (apexHost: string): string => `# agenthost — publish a static site or docs, get a private share link. No signup.

## Publish (one command, zero install)
# A single .md or .html — pipe it straight in with its Content-Type (md renders,
# html is served as-is; the file lands at the site root /):
curl -s --data-binary @report.md \\
  -H 'Content-Type: text/markdown' \\
  https://${apexHost}/publish?id=report

# A whole folder — gzip a tar of it:
tar czf - -C ./dist . | curl -s --data-binary @- \\
  -H 'Content-Type: application/gzip' \\
  https://${apexHost}/publish?id=myblog

## Response (JSON)
{
  "shareUrl": "https://cleverotter4f2-myblog.${apexHost}/?k=<key>",  // hand THIS to a human; private + pre-authed
  "url": "https://cleverotter4f2-myblog.${apexHost}/",              // bare URL (prompts for the key)
  "accessKey": "<the site access key, also embedded in shareUrl>",
  "username": "cleverotter4f2",                                          // your account name (auto-generated, no hyphens)
  "ownerToken": "<SAVE THIS to redeploy the same URL later>"
}

## Redeploy the SAME url (needs ownerToken)
tar czf - -C ./dist . | curl --data-binary @- \\
  -H 'Content-Type: application/gzip' \\
  -H 'Authorization: Bearer <ownerToken>' \\
  'https://${apexHost}/publish?id=myblog&username=<username>'

## Asset paths
Each site is the root of its own subdomain ({username}-{id}.${apexHost}), so
both absolute and relative asset paths work:
  <link href="/css/app.css">     GOOD
  <link href="./css/app.css">    GOOD

## Notes
- Static files OR markdown. /index.html is the default doc; a folder of .md renders as a
  GitBook-style docs site (sidebar + README.md as home; optional SUMMARY.md for ordering).
- Sites are PRIVATE by default. Share the shareUrl; visitors stay logged in via a cookie.
  Every page has a "Share" button that copies a key-embedded link.
- Limits (free): ${free.filesPerSite} files, ${mb(free.perFile)}/file, ${mb(free.perSite)}/site, ${mb(free.perUser)}/account. Hosted sites are noindex.
- Free sites are deleted ${free.retentionDays} days after the last publish — redeploy to keep alive.

## Install as a skill (optional — persist this contract)
This publish contract ships as an Agent Skill (SKILL.md + references), so you don't
have to re-read this file on every run. Install it once and it's always in reach.
- Any agent: fetch the skill from https://${apexHost} and load its SKILL.md.
- From source: https://github.com/ceifa/agenthost/tree/main/skills/agenthost
- OpenClaw: openclaw skills install @ceifa/agenthost
- skills.sh: npx skills add ceifa/agenthost --skill agenthost
- Hermes: hermes skills tap add ceifa/agenthost
`;
