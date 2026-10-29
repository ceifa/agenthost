# Deploying agenthost from scratch

agenthost is one Cloudflare Worker plus one R2 bucket. This guide takes you from
a fresh clone to a live deployment on **your own domain**. Nothing in the repo is
tied to a specific operator — every environment-specific value (domain, admin
email, Access team, API tokens) is supplied by you through config and secrets.

## Prerequisites

- A **Cloudflare account** (the free plan is enough to start).
- A **domain managed by Cloudflare** (the zone must be active on your account).
  This guide calls it `example.com`; substitute yours everywhere.
- **Node 22.22+** and **pnpm** (`corepack enable` then `pnpm --version`).
- **Wrangler** is installed as a dev dependency — you'll run it via `pnpm`.

Log in once: `pnpm wrangler login`.

## 1. Configure your domain

Copy the example and fill in your values:

```bash
cp deploy.env.example deploy.env
```

- `CLOUDFLARE_ACCOUNT_ID` → your Cloudflare account ID (`wrangler whoami`).
- `APEX_HOST` → your apex, e.g. `example.com`. The Worker routes
  `example.com/*` and `*.example.com/*` are derived from it.
- `ZONE_NAME` → only if `APEX_HOST` is not the zone apex itself.
- `R2_BUCKET_NAME` → only if you want a bucket other than `agenthost-sites`.

`deploy.env` is git-ignored, so your values never land in the repo and
`worker/wrangler.jsonc` stays as shipped. `pnpm run deploy`, `pnpm dev` and
`pnpm wrangler …` generate `worker/wrangler.deploy.json` from both files and run Wrangler against
it. The landing page and admin builds read `APEX_HOST` the same way.
Environment variables override `deploy.env`.

Run Wrangler commands through `pnpm wrangler` (for example
`pnpm wrangler secret put ACCESS_AUD`) so they target the account in
`deploy.env`. A plain `wrangler` in `worker/` uses `wrangler.jsonc` as shipped.

The admin-auth values (`ALLOWED_ADMIN_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`)
are **not** set here — they ship as secrets, configured in step 4. While unset, the
admin fails closed (403); the public publish/serve flow works without them.

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
pnpm wrangler r2 bucket create agenthost-sites
```

Use the same name as `R2_BUCKET_NAME` (default `agenthost-sites`).

### Direct-upload S3 credentials

Large-file uploads need object-scoped presigned URLs. In **R2 → Manage R2 API Tokens**, create a token with **Object Read & Write** restricted to this bucket. Put its S3 credentials into Worker secrets:

```bash
pnpm wrangler secret put R2_ACCESS_KEY_ID
pnpm wrangler secret put R2_SECRET_ACCESS_KEY
```

`R2_ACCOUNT_ID` and `R2_BUCKET_NAME` follow `CLOUDFLARE_ACCOUNT_ID` and the bucket from step 1. Account ID and bucket name are public identifiers; only the access key and secret are sensitive. The Worker uses them to sign upload URLs but never receives those bodies. No public-bucket setting is required.

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
   pnpm wrangler secret put ACCESS_TEAM_DOMAIN   # your Zero Trust team name (the <team> in https://<team>.cloudflareaccess.com)
   pnpm wrangler secret put ACCESS_AUD           # the Application Audience (AUD) tag from the Access app
   pnpm wrangler secret put ALLOWED_ADMIN_EMAIL  # the email your Access policy allows
   ```
   (Or set them in the dashboard: Worker → *Settings → Variables and Secrets*, as
   type **Secret**.) The Worker reads them via `env.*` exactly as it would a var —
   no code change either way.

These aren't secrets because they're cryptographically sensitive — they gate
nothing on their own; the Access JWT signature is the actual security boundary.
They ship as secrets so no operator's identity lives in the repo, and because
secrets survive `wrangler deploy` untouched (dashboard-only *vars* would be wiped
on the next deploy unless declared in config).

## 5. Deploy

```bash
pnpm install
pnpm run deploy
```

`pnpm run deploy` builds the landing (Astro) and admin (Svelte) to static output,
copies them into `public/`, and runs one `wrangler deploy` that ships the Worker +
both static bundles.

## 6. Verify

```bash
# publish a one-file site
echo '<h1>hello</h1>' | curl -s -X PUT --data-binary @- https://example.com/shares/test
```

The JSON response includes a `url` — open it and you should see the page over
valid HTTPS on `{username}-test.example.com`. `https://example.com/llms.txt`
should return the publish instructions with your domain baked in, and so should
`https://example.com/skill/SKILL.md` for the agent skill.

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
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.env` | yes | Account the Worker deploys to. |
| `APEX_HOST` | `deploy.env` | yes | Your apex/control-plane domain; routes are derived from it. |
| `ZONE_NAME` | `deploy.env` | no | Zone holding `APEX_HOST`, when it is not the apex itself. |
| `R2_ACCOUNT_ID` | from `CLOUDFLARE_ACCOUNT_ID` | uploads | Public account identifier used in the R2 S3 endpoint. |
| `R2_BUCKET_NAME` | `deploy.env` | uploads | Bucket holding every share (default `agenthost-sites`). |
| `R2_ACCESS_KEY_ID` | secret | uploads | Bucket-scoped S3 access key used only to sign URLs. |
| `R2_SECRET_ACCESS_KEY` | secret | uploads | Bucket-scoped S3 secret used only to sign URLs. |
| `ALLOWED_ADMIN_EMAIL` | secret (`wrangler secret put`) | admin only | Email allowed into the admin. |
| `ACCESS_TEAM_DOMAIN` | secret (`wrangler secret put`) | admin only | Zero Trust team name. |
| `ACCESS_AUD` | secret (`wrangler secret put`) | admin only | Access Application AUD tag. |
| `DEV_MODE` | `.dev.vars` | local dev | `1` bypasses Access + enables `?__host=`. |

Tunable limits/quotas (account storage, retention, files per share, etc.) live in
`worker/src/config.ts`.

## Control records

Small JSON control records (`_users/`, `_sites/`) live in
R2 `customMetadata.json` with empty bodies; inspection tools must read custom metadata,
not the body. The Worker no longer reads the older layouts, so a bucket from before
2026-10-18 needs its legacy records migrated before this Worker serves it.

The shares API replaced `/publish` and the separate asset uploads. Objects under
`assets/` and `_assets/` are no longer read and can be deleted. An owner token issued
before it keeps working as `{username}.{token}`.
