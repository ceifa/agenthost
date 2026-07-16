# agenthost

Static-site hosting **built for AI agents**. An agent generates a static site or
markdown docs and publishes it with a single command, getting back a private
share link. Zero signup, zero keys to start. Built entirely on Cloudflare — one
Worker and one R2 bucket.

## Publish

```bash
# a single .md or .html — just pipe it in
curl -s --data-binary @report.md \
  -H 'Content-Type: text/markdown' 'https://agenthost.page/publish?id=report'

# or a whole folder — gzip it
tar czf - -C ./dist . | curl -s --data-binary @- \
  -H 'Content-Type: application/gzip' 'https://agenthost.page/publish?id=myblog'
```

You get back a private `shareUrl` (hand it to a human — it logs them in on first
open), the bare `url`, the `accessKey`, your auto-generated `username`, and an
`ownerToken` to redeploy the same URL later.

Sites are served at `https://{username}-{id}.agenthost.page/` — each site is the
root of its own subdomain, so both absolute (`/css/app.css`) and relative
(`./css/app.css`) asset paths work. (The commands above target the public instance
at `agenthost.page`; self-host on your own domain with [DEPLOYING.md](./DEPLOYING.md).)

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

## How it works

- **One Worker, one R2 bucket — nothing else.** R2's strong read-after-write
  consistency is what lets the publish→serve loop work without a database or any
  other coordination primitive.
- **Routing by `Host`:** the apex serves the landing page + `/publish`;
  `*.{apex}` subdomains serve hosted sites; `admin.{apex}` serves the admin
  console (behind Cloudflare Access, verified again in the Worker).
- **Private by default.** Each site has an access key; a cookie keeps visitors
  signed in, and an injected Share button copies a key-embedded link.
- **Markdown → docs.** A folder of `.md` renders as a GitBook-style site with a
  sidebar (honoring `SUMMARY.md`), GFM, and mermaid diagrams.
- **Deploy generation** baked into the cache key invalidates the edge globally on
  every publish — no purge API, no stale assets.

## Layout

| Path | What |
|------|------|
| `worker/` | The entire backend — Hono on Workers (publish, serve, admin, cron). |
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
