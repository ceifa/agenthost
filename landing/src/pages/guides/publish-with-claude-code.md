---
layout: ../../layouts/Guide.astro
title: Publish a website from Claude Code
description: Publish an HTML page or static website from Claude Code with agenthost. Get a private link, share it, and update the same URL without signup.
---

Claude Code can build an HTML report, a prototype or a folder of Markdown docs on your machine. With agenthost, it can also publish that output and give you a **private link to share**. Free publishing needs no signup, API key or hosting configuration.

This guide walks through a static website: build it, publish it, open the link, then update the same address. The same publishing endpoint works with Codex, Cursor and other agents that can run shell commands.

## 1. Build a page that can be hosted

Start with a project in Claude Code and ask for a deliverable:

> Build a single index.html page showing a sample project status report. Include the styling in the file, use fictional data, and make it readable on mobile.

A single HTML file is enough. For a framework project, ask the agent to run your project's build command and identify the static output folder, such as `dist`. That folder should contain `index.html` and the CSS, JavaScript and images the page needs.

**agenthost serves static files.** It does not run a Node server, server-side rendering or a database. If your project needs a backend, host that separately and publish only the static frontend. Never include `.env` files, server credentials or source files containing secrets in the published folder.

## 2. Ask Claude Code to publish it

Once the page works locally, say:

> Publish this with agenthost.page and send me the private link. Read https://agenthost.page/llms.txt for the publishing instructions. Reuse my existing agenthost account if one is saved; otherwise save the username and ownerToken from the first publish in durable secret storage. Keep the original private share link so future updates use the same address.

The agent can use the publishing API directly with `curl`; an agenthost skill installation is optional.

For a **first-ever publish** of one HTML file, the command is:

```bash
curl --silent --show-error --fail-with-body \
  --data-binary @index.html \
  -H 'Content-Type: text/html' \
  'https://agenthost.page/publish?id=report'
```

For a static build folder, use this instead:

```bash
tar cf - -C ./dist . | curl --silent --show-error --fail-with-body \
  --data-binary @- \
  'https://agenthost.page/publish?id=demo'
```

Choose one of those commands for the initial publish. **Every publish without an owner token creates a new account**, even when the `id` is the same. If you have already published, use the authenticated command in step 4 instead.

A folder of Markdown files can use the same tar command, with `./docs` in place of `./dist`. Include `README.md` as the home page and optionally `SUMMARY.md` to control the sidebar order.

## 3. Open and share the private link

The first response includes fields like these (the values below are placeholders):

```json
{
  "shareUrl": "https://YOUR_USERNAME-report.agenthost.page/?k=YOUR_ACCESS_KEY",
  "url": "https://YOUR_USERNAME-report.agenthost.page/",
  "username": "YOUR_USERNAME",
  "ownerToken": "YOUR_OWNER_TOKEN"
}
```

Open **`shareUrl`**, then check the layout and links before forwarding it. Its access key signs a visitor in on first open. The bare `url` asks for a key, so it is not the link to send to a new visitor.

Anyone with the private share link can open the site, so share it only with the people you intend to give access. Hosted sites carry `noindex` directives, including sites whose access gate is later removed. The agenthost homepage and publishing guide can appear in search; your published content is marked to stay out of search results.

Store `username` and `ownerToken` in your environment's durable secret storage. The owner token grants publishing access and is returned only when the account is created. Do not put it in the published files or give it to someone who only needs to view the page.

## 4. Update the website at the same URL

Ask Claude Code to edit the page, rebuild if needed, and republish with the saved account and the same site `id`. For the single-file `report` example, with your saved credentials available as environment variables:

```bash
curl --silent --show-error --fail-with-body \
  --data-binary @index.html \
  -H 'Content-Type: text/html' \
  -H "Authorization: Bearer $AGENTHOST_OWNER_TOKEN" \
  "https://agenthost.page/publish?id=report&username=$AGENTHOST_USERNAME"
```

For the folder example, keep the `demo` id:

```bash
tar cf - -C ./dist . | curl --silent --show-error --fail-with-body \
  --data-binary @- \
  -H "Authorization: Bearer $AGENTHOST_OWNER_TOKEN" \
  "https://agenthost.page/publish?id=demo&username=$AGENTHOST_USERNAME"
```

An update replaces the site's content. **Keep the original key-bearing share link**: the access key is returned only on a site's first publish, and an update's response has a bare share URL. The original link still opens the updated page. If you lose it, ask the agent to rotate the access key using the [publishing API instructions](/llms.txt); rotation invalidates the old links.

## Free hosting limits

Free static sites allow up to 50 files, 5 MB per file, 250 MB per site and 500 MB per account. A free site is removed 15 days after its last publish. Republishing resets that timer and keeps the same address while the site still exists.

Downloadable videos, datasets and archives use a separate direct-upload flow, with up to 100 MB per asset on free accounts. They should not be packed into a static site when they exceed the per-file limit. Ask your agent to follow the asset instructions in [llms.txt](/llms.txt).

## Troubleshooting

### The link asks for an access key

Use the original `shareUrl` containing `?k=`, rather than the bare `url` or the URL returned by a later update. If no valid private link is saved, rotate the key to create a new one.

### The page opens, but CSS or images are missing

Publish the whole built folder, not just its HTML file. Run the build first and confirm `index.html` and its referenced assets are in the output directory. Each site has its own subdomain, so both absolute paths such as `/css/app.css` and relative paths such as `./css/app.css` work when the files exist.

### Publishing returns an archive or size error

Send a tar archive for a folder; zip files are not supported. Check the free limits above, remove unnecessary build files, and make sure you are publishing the output folder rather than `node_modules` or the whole repository.

### An update creates a different address

Check that the agent reused the saved `username`, sent the owner token in the Authorization header, and kept the same `id`. An anonymous request creates another account instead of updating your original site.

Ready to share something? [Return to agenthost](/) and ask your agent to publish it.
