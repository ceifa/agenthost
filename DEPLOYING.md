# Deploying agenthost from scratch

agenthost is one Cloudflare Worker plus one R2 bucket. This guide takes you from
a fresh clone to a live deployment on **your own domain**. Nothing in the repo is
tied to a specific operator — every environment-specific value (domain, admin
email, Access team, API tokens) is supplied by you through config and secrets.

## Prerequisites

- A **Cloudflare account** (the free plan is enough to start).
- A **domain managed by Cloudflare** (the zone must be active on your account).
  This guide calls it `example.com`; substitute yours everywhere.
- **Node 20+** and **pnpm** (`corepack enable` then `pnpm --version`).
- **Wrangler** is installed as a dev dependency — you'll run it via `pnpm`.

Log in once: `pnpm -C worker exec wrangler login`.

## 1. Configure your domain

Edit `worker/wrangler.jsonc`:

- `vars.APEX_HOST` → your apex, e.g. `"example.com"`.
- `routes` → point both patterns at your zone:
  ```jsonc
  "routes": [
    { "pattern": "example.com/*",   "zone_name": "example.com" },
    { "pattern": "*.example.com/*", "zone_name": "example.com" }
  ]
  ```
- `r2_buckets[0].bucket_name` → the bucket you'll create in step 3 (default
  `agenthost-sites` is fine).

The admin-auth values (`ALLOWED_ADMIN_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`)
are **not** set here — they ship as secrets, configured in step 4. While unset, the
admin fails closed (403); the public publish/serve flow works without them.

If you serve the landing page on your own domain, also set `site` in
`landing/astro.config.mjs` to `https://example.com`.

## 2. DNS + TLS (the wildcard is load-bearing)

In the Cloudflare dashboard for your zone:

1. Add a **proxied** (orange-cloud) `A` record: name `*`, content `192.0.2.1`
   (a dummy — the Worker answers, not the origin). The proxy must be on so the
   `*.example.com/*` Worker route catches subdomain requests.
2. Confirm **Universal SSL** is active and its certificate covers
   `*.example.com`. Free Universal SSL covers a **single** wildcard level — which
   is exactly why sites are addressed as `{username}-{siteId}.example.com` (one
   label) rather than `{siteId}.{username}.example.com` (two). If the wildcard
   cert isn't issued, HTTPS on subdomains fails; this is the #1 thing to verify.

## 3. Create the R2 bucket

```bash
pnpm -C worker exec wrangler r2 bucket create agenthost-sites
```

Use the same name you put in `wrangler.jsonc`.

## 4. Admin auth (Cloudflare Access)

The admin console lives on `admin.example.com` and is protected by Cloudflare
Access. The Worker independently verifies the signed Access JWT, so it stays safe
even if a request reaches it without passing through Access.

1. Add a **proxied** DNS record for `admin.example.com` (so the
   `*.example.com/*` route catches it) — a CNAME to `example.com` or an `A` to
   `192.0.2.1` both work.
2. Create a **Zero Trust → Access → Application** (self-hosted) on
   `admin.example.com`, with a policy allowing **your** email.
3. Set these three as **secrets** — they carry your identity, so they stay out of
   the repo. `wrangler secret put` prompts for each value:
   ```bash
   pnpm -C worker exec wrangler secret put ACCESS_TEAM_DOMAIN   # your Zero Trust team name (the <team> in https://<team>.cloudflareaccess.com)
   pnpm -C worker exec wrangler secret put ACCESS_AUD           # the Application Audience (AUD) tag from the Access app
   pnpm -C worker exec wrangler secret put ALLOWED_ADMIN_EMAIL  # the email your Access policy allows
   ```
   (Or set them in the dashboard: Worker → *Settings → Variables and Secrets*, as
   type **Secret**.) The Worker reads them via `env.*` exactly as it would a var —
   no code change either way.

These aren't secrets because they're cryptographically sensitive — they gate
nothing on their own; the Access JWT signature is the actual security boundary.
They ship as secrets so no operator's identity lives in the repo, and because
secrets survive `wrangler deploy` untouched (dashboard-only *vars* would be wiped
on the next deploy unless declared in config).

## 5. Optional: custom domains (no paid tier needed)

To let a user bring their own domain (`status.acme.com`), you don't need
Cloudflare for SaaS. Serving is driven entirely by a `_domains/{host}` mapping in
R2; getting the domain's traffic to the Worker and its TLS cert is a free,
one-time dashboard step per domain that **you** (the admin) perform:

1. **Add the domain as a zone** in your Cloudflare account (Free plan). Change its
   nameservers at the registrar to the ones Cloudflare gives you. Universal SSL
   then issues a certificate for it at no cost.
2. **Attach this Worker as a Custom Domain**: in the Worker's *Settings → Domains
   & Routes → Add Custom Domain*, enter the host (e.g. `status.acme.com`). This
   creates the proxied DNS record and cert automatically.
3. **Record the mapping** in the admin console (the "+ domain" button on a site,
   which calls `POST /admin/api/domain`). The API response returns this same
   checklist; serving starts working the moment the mapping is written and DNS/TLS
   are live.

The trade-off versus Cloudflare for SaaS: the customer's whole zone lives in
*your* account (they delegate nameservers to you), so this suits a handful of
admin-registered domains rather than thousands of self-serve ones. No API token
or `wrangler.jsonc` change is required.

## 6. Deploy

```bash
pnpm install
pnpm run deploy
```

`pnpm run deploy` builds the landing (Astro) and admin (Svelte) to static output,
copies them into `public/`, and runs one `wrangler deploy` that ships the Worker +
both static bundles.

## 7. Verify

```bash
# publish a one-file site
echo '<h1>hello</h1>' | curl -s --data-binary @- \
  -H 'Content-Type: text/html' 'https://example.com/publish?id=test'
```

The JSON response includes a `shareUrl` — open it and you should see the page over
valid HTTPS on `{username}-test.example.com`. `https://example.com/llms.txt`
should return the publish instructions with your domain baked in.

## Local development

Create `worker/.dev.vars` (git-ignored) from the example:

```bash
cp worker/.dev.vars.example worker/.dev.vars
```

`DEV_MODE=1` bypasses Cloudflare Access for the admin and enables the
`?__host=` routing override so you can reach any host locally. Then:

```bash
pnpm dev            # wrangler dev with a local (Miniflare) R2 + cache
pnpm -C admin dev   # admin SPA, proxying its API to the local worker
```

`wrangler dev` simulates R2 and the Cache API locally, so the full
publish → serve loop runs offline against a fixture directory.

## Environment / config reference

| Name | Where | Required | Purpose |
|------|-------|----------|---------|
| `APEX_HOST` | `wrangler.jsonc` var | yes | Your apex/control-plane domain. |
| `ALLOWED_ADMIN_EMAIL` | secret (`wrangler secret put`) | admin only | Email allowed into the admin. |
| `ACCESS_TEAM_DOMAIN` | secret (`wrangler secret put`) | admin only | Zero Trust team name. |
| `ACCESS_AUD` | secret (`wrangler secret put`) | admin only | Access Application AUD tag. |
| `DEV_MODE` | `.dev.vars` | local dev | `1` bypasses Access + enables `?__host=`. |

Custom domains need no config or secrets — see §5 (dashboard-only setup).

Tunable limits/quotas (per-file size, files per site, retention, etc.) live in
`worker/src/config.ts`.
