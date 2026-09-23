---
name: agenthost
version: 0.3.0
description: "Publishes a page, docs or file behind a private share link. Use when a deliverable reads better as a page than as chat, or is too big to send."
metadata:
  homepage: https://agenthost.page
  hermes:
    category: publishing
    tags: [hosting, static-site, publish, share, docs]
  openclaw:
    emoji: "🚀"
    requires:
      bins: [curl, tar]
---

Publish a page, a folder or a set of Markdown docs, or upload a large file, and get back a **private link** a human opens in one click. It's plain `curl` and `tar` against `https://agenthost.page` (or the user's self-hosted domain), no install needed.

## One account, reused forever

A publish without `Authorization` **mints a brand-new account**, every time, even if you pass a `username`. Do that exactly once: from the first response, save `username` and `ownerToken` wherever the environment keeps durable secrets, and send them on every publish after, new `id`s included. Without it nothing can be redeployed and assets can't be uploaded. The `ownerToken` is shown once; lose it and you start over with new URLs.

Below, `$AGENTHOST_USERNAME` and `$AGENTHOST_OWNER_TOKEN` hold them.

## Publish

`id` becomes the subdomain: `{username}-{id}.agenthost.page`. Same account + same `id` → same URL, content replaced. Leaving out `id` publishes to `site`, overwriting it.

```bash
# first publish ever: mints the account
curl -s --data-binary @report.md 'https://agenthost.page/publish?id=report'

# every publish after
curl -s --data-binary @report.md \
  -H "Authorization: Bearer $AGENTHOST_OWNER_TOKEN" \
  "https://agenthost.page/publish?id=report&username=$AGENTHOST_USERNAME"
```

What the body can be:

- **One `.md` or `.html`**: served at `/`, Markdown rendered. The type is sniffed from the bytes, so no `Content-Type` is needed.
- **A folder**: pipe a gzipped tar, `tar czf - -C ./dist . | curl -s --data-binary @- …`. Zip is rejected. A folder of `.md` becomes a docs site (sidebar, `README.md` as home, `SUMMARY.md` for order and nesting, GFM, mermaid, highlighted code).
- **Any other single file**: add `&file=<name>`; the extension sets the served type. It replaces the whole site.

Absolute (`/css/app.css`) and relative (`./css/app.css`) asset paths both resolve, since each site is its own subdomain root.

## What to hand the human

`shareUrl` carries the site's access key (`?k=…`) and logs the visitor in on first open. **The key is only returned on a site's first publish**: a redeploy returns a bare `shareUrl` that asks for a key. So record the link from the first publish of each `id` next to the deliverable, and give that same link again after redeploys. Pages already open in a browser reload themselves when you republish.

If the link is lost, `POST /key/rotate` mints a new one and kills the old ones. To remove the gate completely, make the site public (see the reference).

## Upload a downloadable asset

Use this for files that aren't a site (video, archive, dataset): up to 100 MB on free, 5 GB on paid. It needs the account. The bytes go straight to R2, never through agenthost.

```bash
# 1. initiate; bytes must be the exact file size
curl -s -X POST -H "Authorization: Bearer $AGENTHOST_OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"demo.mp4","bytes":757603783,"contentType":"video/mp4"}' \
  "https://agenthost.page/asset?username=$AGENTHOST_USERNAME"

# 2. within 15 min: PUT to uploadUrl with every uploadHeaders value verbatim
curl -s --upload-file demo.mp4 \
  -H 'content-type: <uploadHeaders.content-type>' \
  -H 'content-disposition: <uploadHeaders.content-disposition>' \
  '<uploadUrl>'

# 3. complete; expect {"ok":true}
curl -s -X POST -H "Authorization: Bearer $AGENTHOST_OWNER_TOKEN" '<completeUrl>'
```

Hand over the `shareUrl` from **step 1**; completing doesn't repeat it.

## Limits

- Free: 50 files, 5 MB per file, 250 MB per site, 500 MB per account (sites and assets combined). Free sites are deleted 15 days after their last publish, so republish to keep one alive.
- `_gen` and `_meta` are reserved filenames.

Public sites, key rotation, recovery email, deleting assets, every response field and error code: [references/http-api.md](references/http-api.md).
