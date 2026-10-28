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
      bins: [curl, tar, jq]
---

Plain `curl` and `tar` against `https://agenthost.page`. A share is one tree of files served at `https://{username}-{id}.agenthost.page`.

## One account, reused forever

A `PUT` without `Authorization` **creates a new account** every time. Make that call once, save the `ownerToken` it returns wherever the environment keeps durable secrets (it is shown once), and send it on every later call. Lose it and you start over with new URLs. Below, `$AGENTHOST_TOKEN` holds it.

## Publish

```bash
# one .md or .html, served at / (first call ever: drop the -H to create the account)
curl -s -X PUT --data-binary @report.md -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  https://agenthost.page/shares/report

# a folder: pipe a tar (zip is rejected)
tar cf - -C ./dist . | curl -s -X PUT --data-binary @- -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  https://agenthost.page/shares/myblog

# any one file at a path, keeping the rest of the share
curl -s -X PUT --data-binary @chart.png -H "Authorization: Bearer $AGENTHOST_TOKEN" \
  https://agenthost.page/shares/myblog/files/img/chart.png
```

- `PUT /shares/{id}` **replaces every file**; `?mode=merge` keeps the ones the body doesn't carry. The same `id` keeps the same URL.
- A file is named only by its URL path. Percent-encode spaces and accents.
- `.md` files make a docs site, with GFM and ` ```mermaid ` diagrams rendered: `README.md` is the home, `SUMMARY.md` sets the order. With no `index.html` or Markdown, `/` previews the single file or lists them all.

## Large files

Bodies over ~100 MB are refused; those go straight to storage. Run this as one command, so the signed URL never has to be read or retyped:

```bash
# reserve the exact size, PUT the file to the signed URL, then commit (uncommitted uploads are discarded after a day)
F=demo.mp4 API=https://agenthost.page/shares/demo/uploads AUTH="Authorization: Bearer $AGENTHOST_TOKEN"
R=$(curl -s -H "$AUTH" --data "{\"bytes\":$(wc -c < "$F")}" "$API/prepare/$F") &&
curl -s --fail-with-body -T "$F" "$(printf '%s' "$R" | jq -er .uploadUrl || printf '%s\n' "$R" >&2)" &&
curl -s -X POST -H "$AUTH" "$API/complete/$F"
```

## What to hand the human

The `url` in the response, exactly as returned: it carries the access key (`?k=…`) and logs the visitor in. `GET /shares/{id}` returns it again. `?download` on a file's URL saves it instead of opening it.

## Limits

Free accounts store 500 MB across all shares, and a free share is deleted 15 days after its last write. Any plan: 1000 files per share, 5 GB per file.

Visibility, key rotation, deletes, recovery email, every field and error: [references/http-api.md](references/http-api.md).
