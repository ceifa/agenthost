---
name: agenthost
version: 0.2.0
description: >-
  Publishes static sites, Markdown docs, and large downloadable assets to hosted private share links. Use to publish a page or share a file with someone.
metadata:
  homepage: https://agenthost.page
  hermes:
    category: publishing
    tags: [hosting, static-site, publish, share, docs, cloudflare]
  openclaw:
    emoji: "🚀"
    requires:
      bins: [tar, curl, jq]
---

Publish static files or Markdown, or upload a large binary asset directly to R2, then get back a **private, pre-authenticated share link** for a human. `id` becomes the subdomain for sites: `{username}-{id}.agenthost.page`.

## Publish

**Single file** — pipe a `.md` or `.html` straight in. Markdown renders, HTML is served as-is; the file lands at `/`.

```bash
curl -s --data-binary @report.md \
  'https://agenthost.page/publish?id=report'
```

**Folder** — pipe a gzipped tar of the directory.

```bash
tar czf - -C ./dist . | curl -s --data-binary @- \
  'https://agenthost.page/publish?id=myblog'
```

No `Content-Type` needed either way. For a single file of any other type, add `?file=<name>`.

The JSON response has two fields that matter:

- **`shareUrl`** — hand THIS to the human. Opening it logs the visitor in via a cookie on first load.
- **`ownerToken`** — save it. Shown **once**; the only way to redeploy to the same URL.

Both absolute (`/css/app.css`) and relative (`./css/app.css`) asset paths
resolve, since each site is its own subdomain root.

## Upload a large asset

Asset payloads **never pass through the Worker**. The helper requests an object-scoped signed URL, streams the file directly to R2, verifies completion, and prints a share page with a Download button.

Assets require an existing account. Set the credentials returned by your first site publish, then run:

```bash
AGENTHOST_USERNAME=<username> AGENTHOST_OWNER_TOKEN=<ownerToken> \
  skills/agenthost/scripts/upload-asset.sh ./video.mp4
```

Free accounts accept assets up to 100 MB. Paid accounts accept a single direct upload up to 5 GB. Signed uploads expire after 15 minutes; share pages mint five-minute direct-R2 download URLs as needed.

## Redeploy the same URL

Reuse the `ownerToken` and `username` from the first publish:

```bash
tar czf - -C ./dist . | curl -s --data-binary @- \
  -H 'Authorization: Bearer <ownerToken>' \
  'https://agenthost.page/publish?id=myblog&username=<username>'
```

## Notes

- **Markdown docs**: a folder of `.md` renders GitBook-style (sidebar + `README.md` home, heading anchors, prev/next). Add `SUMMARY.md` for ordering — its list indentation becomes sidebar nesting. GFM renders, ` ```mermaid ` becomes a diagram, and a fenced block with a declared language (` ```python `) is syntax-highlighted; relative links between docs resolve as written; mixed `.html`+`.md` works.
- **Limits (free tier)**: 50 files · 5 MB/file · 250 MB/site · 500 MB/account. Sites carry `noindex` and are deleted 15 days after their last publish.
- Making a site public, key rotation, recovery email, full field list, and error codes: [references/http-api.md](references/http-api.md).
