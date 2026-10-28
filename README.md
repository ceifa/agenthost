# agenthost

Hosting **built for AI agents**. An agent publishes a page, Markdown docs, or any
files — videos and datasets included — as a *share* and gets back a private link.
Built entirely on Cloudflare — one Worker and one R2 bucket.

## Publish

```bash
# a single .md or .html — just pipe it in, no headers
curl -s -X PUT --data-binary @report.md https://agenthost.page/shares/report

# or a whole folder — tar it
tar cf - -C ./dist . | curl -s -X PUT --data-binary @- https://agenthost.page/shares/myblog
```

You get back a private `url` (hand it to a human — the access key rides in it and
logs them in on first open) and an `ownerToken` that every later call sends to
update the same URL or create new ones.

Shares are served at `https://{username}-{id}.agenthost.page/` — each one is the
root of its own subdomain, so both absolute (`/css/app.css`) and relative
(`./css/app.css`) asset paths work. A share with no page of its own previews its
file at `/` (video, audio, images and PDFs play inline) or lists its files.
(The commands above target the public instance at `agenthost.page`; self-host on
your own domain with [DEPLOYING.md](./DEPLOYING.md).)

## Large files

Files too big to stream through the Worker go straight to R2: reserve
(`POST /shares/{id}/uploads`), then `PUT` the file to the signed URL it returns.
No completion call. The file joins the share like any other: `<video src="/demo.mp4">` in
the share's page works, with seeking. Files can be up to 5 GB. The
exact recipe is in the [skill](./skills/agenthost/SKILL.md#large-files).

## Install the skill

agenthost ships as an [Agent Skill](https://agentskills.io) at
[`skills/agenthost/`](./skills/agenthost/). It's a plain `SKILL.md` + `references/`,
so any skill installer can pick it up straight from this repo:

| Runtime | Install |
|---------|---------|
| [skills.sh](https://skills.sh) | `npx skills add <owner>/<repo> --skill agenthost` |
| Claude Code | copy `skills/agenthost/` into `~/.claude/skills/` |
| Hermes | `hermes skills tap add <owner>/<repo>` |
| OpenClaw | import the repo into ClawHub (reads `skills/agenthost/SKILL.md`) |

Replace `<owner>/<repo>` with this repository (e.g. `you/agenthost`).

Every instance also serves the skill at `https://<apex>/skill/SKILL.md` (and its
references under `/skill/`), with `agenthost.page` replaced by that instance's
`APEX_HOST`, so a self-hosted deployment hands out a skill that points at itself.

## How it works

- **One Worker, one R2 bucket — nothing else.** R2's strong read-after-write
  consistency is what lets the publish→serve loop work without a database or any
  other coordination primitive.
- **Two ways in, one tree:** a tar or file streams through the Worker; a large
  file goes client → R2 on an exact-size presigned PUT. Both land in the same
  share and are served the same way.
- **Routing by `Host`:** the apex serves the landing page + the `/shares` API;
  `*.{apex}` subdomains serve shares; `admin.{apex}` serves the admin
  console (behind Cloudflare Access, verified again in the Worker).
- **Private by default.** Each share has an access key; a cookie keeps visitors
  signed in, and an injected Share button copies a key-embedded link.
- **Markdown → docs.** A folder of `.md` renders as a GitBook-style site: nested
  sidebar (honoring `SUMMARY.md`), on-this-page outline, prev/next, GFM, mermaid,
  server-side syntax highlighting, light and dark.
- **Deploy generation** baked into the cache key invalidates the edge globally on
  every publish — no purge API, no stale assets.

## Layout

| Path | What |
|------|------|
| `worker/` | The entire backend — Hono on Workers (shares API, serve, admin, cron). |
| `landing/` | Astro static landing page, built into `public/`. |
| `admin/` | Svelte SPA admin console, built into `public/admin/`. |
| `skills/agenthost/` | The `agenthost` Agent Skill (`SKILL.md` + `references/`). |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and [DEPLOYING.md](./DEPLOYING.md)
to host your own instance.

## Develop

```bash
pnpm install
pnpm -C worker dev      # wrangler dev with a local R2 + cache
pnpm -C admin dev       # admin SPA, proxying its API to the local worker
```

## Build & deploy

```bash
pnpm deploy             # turbo build → copy dist into public/ → wrangler deploy
```

One `wrangler deploy` ships everything: the landing and admin are built to static
output, copied into `public/`, and served by the Worker via Static Assets. For a
full from-scratch setup on your own domain (DNS, TLS, R2, admin auth, secrets),
see [DEPLOYING.md](./DEPLOYING.md).

## License

[MIT](./LICENSE)
