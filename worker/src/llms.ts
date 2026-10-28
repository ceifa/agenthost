// /llms.txt — machine-readable publish instructions served at the apex.
// The apex host is read from env (APEX_HOST) so the text always reflects the
// deployment, and limits are rendered from config so a quota bump can't silently
// make this lie.

import { LIMITS, MAX_FILE_BYTES, MAX_FILES } from "./config";
import { formatBytes as size } from "./templates";

const free = LIMITS.free;

export const llmsTxt = (apexHost: string): string => `# agenthost — publish a page, docs or files, get a private share link. No signup.

## Publish (one command, zero install)
# A single .md or .html — pipe it straight in (md renders, html is served as-is):
curl -s -X PUT --data-binary @report.md https://${apexHost}/shares/report

# A whole folder — pipe a tar of it:
tar cf - -C ./dist . | curl -s -X PUT --data-binary @- https://${apexHost}/shares/myblog

# Any one file, at a path inside the share (keeps the other files):
curl -s -X PUT --data-binary @chart.png https://${apexHost}/shares/myblog/files/img/chart.png

## Response (JSON)
{
  "url": "https://cleverotter4f2-myblog.${apexHost}/?k=<key>",  // hand THIS to a human; private + pre-authed
  "id": "myblog",
  "username": "cleverotter4f2",
  "fileCount": 12,
  "bytes": 48213,
  "ownerToken": "<SAVE THIS: every later call needs it>"
}
A PUT without Authorization creates a new account. Save ownerToken once and send it after.

## Republish the SAME url
tar cf - -C ./dist . | curl -s -X PUT --data-binary @- \\
  -H 'Authorization: Bearer <ownerToken>' https://${apexHost}/shares/myblog
PUT /shares/<id> replaces every file; add ?mode=merge to keep files the body doesn't carry.
A file is always named in the URL path, percent-encoded.
GET /shares/myblog returns the url again at any time.

## Large files (over ~100 MB, or any file you'd rather not stream through agenthost)
1. POST https://${apexHost}/shares/<id>/uploads/prepare/demo.mp4  {"bytes":<exact size>}
   → uploadUrl, uploadHeaders, url
2. curl -X PUT --upload-file demo.mp4 -H '<each uploadHeaders entry>' '<uploadUrl>'   (within 15 min)
3. POST https://${apexHost}/shares/<id>/uploads/complete/demo.mp4  (no body)
Steps 1 and 3 take the Authorization header. The file joins the share at /demo.mp4.

## What a share shows
- index.html at /, or a folder of .md as a docs site (README.md home, SUMMARY.md for order).
- Neither: / previews a single file (video, image, audio, pdf play inline) or lists the files.
- Any file: ?download saves it instead of opening it.
- Each share is the root of its own subdomain, so /css/app.css and ./css/app.css both work.

## Notes
- Shares are PRIVATE by default. Visitors of the url stay logged in via a cookie.
- Free accounts store ${size(free.perUser)} across all shares. Any share: up to ${MAX_FILES} files, ${size(MAX_FILE_BYTES)} per file.
- Free shares are deleted ${free.retentionDays} days after the last change. Hosted pages are noindex.
- Visibility, key rotation, deletes: https://${apexHost}/skill/references/http-api.md

## Install as a skill (optional — persist this contract)
- Any agent: fetch https://${apexHost}/skill/SKILL.md and its references under /skill/.
- From source: https://github.com/ceifa/agenthost/tree/main/skills/agenthost
- OpenClaw: openclaw skills install @ceifa/agenthost
- skills.sh: npx skills add ceifa/agenthost --skill agenthost
- Hermes: hermes skills tap add ceifa/agenthost
`;
