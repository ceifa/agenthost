---
name: {{skillName}}
version: 0.4.0
description: "Publishes a page, docs or file behind a private share link. Use when a deliverable reads better as a page than as chat, or is too big to send."
metadata:
  homepage: https://{{apexHost}}
  hermes:
    category: publishing
    tags: [hosting, static-site, publish, share, docs]
  openclaw:
    emoji: "🚀"
    requires:
      bins: [curl, tar]
---

Publish a page, a folder or a set of Markdown docs, or upload a large file, and get back a **private link** a human opens in one click. It's plain `curl` and `tar` against `https://{{apexHost}}`, with nothing else to install.

## Install or update

```bash
curl -fsSL https://{{apexHost}}/skill/install.sh | sh
```

It saves this file as `{{skillName}}/SKILL.md` under `~/.claude/skills` and `~/.agents/skills`, and rerunning it updates. To install yourself instead, save `https://{{apexHost}}/skill/SKILL.md` as `<your skills dir>/{{skillName}}/SKILL.md`.

## One account, saved in your home directory

Your account lives in `{{credentialsFile}}`, a curl config that every authenticated request below reads with `-K`. It holds the owner token for {{apexHost}}, so it is named after the host and stays in your home directory. Never copy it into the skill directory or a working tree, where a project-level install could get it committed.

Check for it with `test -f {{credentialsFile}}`, and never `cat` or print it.

- **It exists**: use it.
- **It doesn't**: ask the human whether they already have an account on {{apexHost}}.
  - **They do**: ask them to run this in a terminal on this machine. It prompts for their username, then for their token with the input hidden, so the token never lands in chat or in shell history. Rerunning it replaces the file.

    ```bash
    {{credentialsCommand}}
    ```

  - **They do, but you run in a remote or cloud sandbox** with no terminal they can reach: they may paste their username and token in chat. Write the file with the command under **They don't**, and never echo the token back.
  - **They don't**: publish once without `-K`. A publish without `Authorization` **mints a brand-new account**, every time, even if you pass a `username`. Save the response's `ownerToken` and `username` with this command, in place of `OWNER_TOKEN` and `USERNAME`, and don't repeat the token in your reply. The `ownerToken` is shown once; lose it and you start over with new URLs.

    ```bash
    {{writeCredentialsCommand}}
    ```

## Publish

`id` becomes the subdomain: `{username}-{id}.{{apexHost}}`. Same account + same `id` → same URL, content replaced. Leaving out `id` publishes to `site`, overwriting it.

```bash
curl -s -K {{credentialsFile}} --data-binary @report.md 'https://{{apexHost}}/publish?id=report'

# only when there is no account yet: mints one, then save it as above
curl -s --data-binary @report.md 'https://{{apexHost}}/publish?id=report'
```

What the body can be:

- **One `.md` or `.html`**: served at `/`, Markdown rendered. The type is sniffed from the bytes, so no `Content-Type` is needed.
- **A folder**: pipe a tar, `tar cf - -C ./dist . | curl -s --data-binary @- …`. Zip is rejected. A folder of `.md` becomes a docs site (sidebar, `README.md` as home, `SUMMARY.md` for order and nesting, GFM, mermaid, highlighted code).
- **Any other single file**: add `&file=<name>`; the extension sets the served type. It replaces the whole site.

Absolute (`/css/app.css`) and relative (`./css/app.css`) asset paths both resolve, since each site is its own subdomain root.

## What to hand the human

`shareUrl` carries the site's access key (`?k=…`) and logs the visitor in on first open. **The key is only returned on a site's first publish**: a redeploy returns a bare `shareUrl` that asks for a key. So record the link from the first publish of each `id` next to the deliverable, and give that same link again after redeploys. Pages already open in a browser reload themselves when you republish.

If the link is lost, `POST /key/rotate` mints a new one and kills the old ones. To remove the gate completely, make the site public (see the reference).

## Upload a downloadable asset

Use this for files that aren't a site (video, archive, dataset): up to {{freePerAsset}} on free, {{paidPerAsset}} on paid. It needs the credentials file. The bytes go straight to R2, never through agenthost.

```bash
# 1. initiate; bytes must be the exact file size
curl -s -K {{credentialsFile}} -H 'Content-Type: application/json' \
  --data '{"name":"demo.mp4","bytes":757603783,"contentType":"video/mp4"}' \
  'https://{{apexHost}}/asset'

# 2. within 15 min: PUT to uploadUrl with every uploadHeaders value verbatim, no -K
curl -s --upload-file demo.mp4 \
  -H 'content-type: <uploadHeaders.content-type>' \
  -H 'content-disposition: <uploadHeaders.content-disposition>' \
  '<uploadUrl>'

# 3. complete; expect {"ok":true}
curl -s -K {{credentialsFile}} -X POST '<completeUrl>'
```

Step 2 goes to R2, not to {{apexHost}}, so it must not use `-K`. That would send your owner token to R2 and break the upload's signature.

Hand over the `shareUrl` from **step 1**; completing doesn't repeat it.

## Limits

- Free: {{freeFilesPerSite}} files, {{freePerFile}} per file, {{freePerSite}} per site, {{freePerUser}} per account (sites and assets combined). Free sites are deleted {{freeRetention}} after their last publish, so republish to keep one alive.
- `_gen` and `_meta` are reserved filenames.

Public sites, key rotation, recovery email, deleting assets, every response field and error code: [references/http-api.md](https://{{apexHost}}/skill/references/http-api.md).
