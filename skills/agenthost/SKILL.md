---
name: agenthost
version: 0.4.0
description: "Publishes a page, docs or files behind a private share link. Use when a deliverable reads better as a page than as chat, or is too big to send."
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

Publish a page, a folder, Markdown docs or any files as a **share** and get back a private link a human opens in one click. Plain `curl` and `tar` against `https://agenthost.page`.

## One account, reused forever

A `PUT` without `Authorization` **creates a new account** every time. Do it once: save the `ownerToken` from that first response wherever the environment keeps durable secrets, and send it on every call after, new shares included. It is shown once; lose it and you start over with new URLs. Below, `$AGENTHOST_TOKEN` holds it.

## Publish

`PUT /shares/{id}`. The `id` becomes the address `{username}-{id}.agenthost.page`; the same `id` again replaces the content at the same URL.

```bash
# first call ever: creates the account
curl -s -X PUT --data-binary @report.md https://agenthost.page/shares/report

# every call after
curl -s -X PUT --data-binary @report.md -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  https://agenthost.page/shares/report

# a folder: pipe a tar (zip is rejected)
tar cf - -C ./dist . | curl -s -X PUT --data-binary @- -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  https://agenthost.page/shares/myblog
```

- One `.md` or `.html` serves at `/`. Any other single file needs `?file=<name>`.
- A `PUT` **replaces every file** in the share. Add `?mode=merge` to keep the files the body doesn't carry, e.g. to update a page without re-sending its video.
- A folder of `.md` becomes a docs site: `README.md` is the home, `SUMMARY.md` sets order and nesting.
- With no `index.html` and no Markdown, `/` previews the file (video, image, audio and PDF play inline) or lists the files with download links.

## Large files

Over ~100 MB, a `PUT` body is refused; upload those straight to storage instead. Three calls; the file lands at `path` inside the share (created if new) and joins whatever is already there:

```bash
# 1. reserve; bytes must be the exact file size
curl -s -X POST -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  --data '{"path":"demo.mp4","bytes":757603783}' https://agenthost.page/shares/demo/uploads

# 2. within 15 min: PUT the file to uploadUrl with every uploadHeaders entry, verbatim
curl -s -X PUT --upload-file demo.mp4 -H 'content-length: <…>' -H 'content-type: <…>' '<uploadUrl>'

# 3. complete
curl -s -X POST -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  --data '{"path":"demo.mp4"}' https://agenthost.page/shares/demo/uploads/complete
```

An upload not completed within a day is discarded.

## What to hand the human

Every response carries `url`, already holding the access key (`?k=…`), which logs the visitor in on first open. Hand over exactly that. `GET /shares/{id}` returns it again any time. Pages open in a browser reload themselves when the share changes. Appending `?download` to a file's URL saves it instead of opening it.

## Limits

Free accounts store 500 MB across all their shares. Any share holds up to 1000 files of up to 5 GB each. A free share is deleted 15 days after its last change; any write resets the clock.

Visibility, key rotation, deleting files or shares, recovery email, every field and error: [references/http-api.md](references/http-api.md).
