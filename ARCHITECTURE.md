# agenthost — Architecture

> Static-site hosting **built for AI agents**. An agent generates a static site and
> publishes it with a single command, getting back a public URL. Zero signup, zero key
> to start. Inspired by [postplan](https://www.npmjs.com/package/postplan) (friction-zero
> publish) and [lakebed.dev](https://lakebed.dev) (optional claim-to-upgrade), built
> entirely on **Cloudflare**.

This document is the design the implementation follows — the **why** behind the code in
`worker/`. For running your own instance, see [DEPLOYING.md](./DEPLOYING.md).

---

## 1. Design principles (in priority order)

1. **Simplest thing that works.** One Worker + one R2 bucket. No Durable Objects, no KV,
   no D1, no Postgres in the MVP.
2. **Great agent DX.** One-shot publish, no install required (raw `curl` works), public
   URL back immediately.
3. **Cloudflare-native.** Lean on R2's strong read-after-write consistency instead of
   adding coordination primitives.
4. **Cheap at low scale.** R2 has no egress fees — that is the entire serving economics.
5. **Sane upgrade path.** Anonymous publish → optional paid features (custom username,
   custom domain) enabled by the founder via an admin.

The headline decision: **one Worker + one R2 bucket, and nothing else.** Everything that
would normally need a coordination primitive is either solved by R2's strong
read-after-write consistency or avoided by design (auto-generated usernames remove the
uniqueness-race that would otherwise need a Durable Object).

---

## 2. Cloudflare primitives

**We use:**

- **Workers** — the only compute. One script: routes by `Host`. Apex → landing / publish.
  `*.agenthost.page` → serve a site. `*.workers.dev` → admin (behind Access). Custom domain →
  serve a site. One deploy.
- **R2** — the only byte store. One bucket holds every file of every version of every
  site, plus tiny metadata objects. **Read-after-write is strongly consistent per object**
  — this is what lets us drop Durable Objects/KV.
- **Workers Static Assets** — serves the landing page and the admin UI from the same
  Worker on the apex host (`run_worker_first` so the Worker routes by Host first).
- **Cache API + CDN** — edge-caches served bytes keyed by the generation-pinned cache key
  (`cache://…/g{gen}/{path}`), so bumping `_gen` on deploy instantly orphans old entries —
  no purge API, no mixed assets.
- **Cloudflare Access** — founder-only auth in front of the admin (`*.workers.dev` host).
  Zero auth code.
- **Custom domains (no paid tier)** — bring-your-own-domain (`status.acme.com`) is a
  free `_domains/{host}` mapping in R2 plus a one-time dashboard step: the admin adds
  the domain as a zone and attaches the Worker as a Custom Domain (free routing + TLS).
  No Cloudflare for SaaS. Trade-off: the customer's zone lives in the admin's account.
- **Rate Limiting Rules (WAF)** — zone-level rate limit on `/publish`. Zero code, no DO.
- **Wildcard DNS + Worker route** — proxied `*` A-record (`192.0.2.1` dummy) + route
  `*.agenthost.page/*`. Free Universal SSL covers the **single-level** wildcard
  `*.agenthost.page` on all plans (verified — no Enterprise/ACM needed).

**We deliberately do NOT use (yet):**

- **Durable Objects** — dropped. R2 read-after-write covers the publish→verify loop;
  auto-generated usernames remove the uniqueness race. Re-add only if a future feature
  needs serialized cross-request coordination.
- **KV** — eventually consistent; would reintroduce the read-your-write gap on the
  publish→verify loop agents run constantly.
- **D1** — no listing/search/billing dashboard needed in the MVP. Admin uses `R2.list`.
  D1 can be added later, additively, purely for the admin if listing outgrows `R2.list`.
- **Workers for Platforms, Queues, Sandbox** — static hosting only.

> ⚠️ **TLS constraint that shaped the URL scheme:** free Universal SSL covers only a
> *single* wildcard level (`*.agenthost.page`). A scheme like
> `{site}.{user}.agenthost.page` is multi-level and would require a paid/advanced
> certificate. This is why site and user are packed into **one** label
> (`{username}-{siteId}.agenthost.page`) — it stays a single wildcard level while still
> giving every site its own origin.

---

## 3. URL scheme

```
https://{username}-{siteId}.agenthost.page/...
```

- **`{username}`** — the account. **Auto-generated**, simple and memorable
  (e.g. `cleverotter4f2`) and **hyphen-free** — the hyphen is the `{username}-{siteId}`
  separator, so the host splits back on its *first* hyphen. The hex suffix gives enough
  entropy that collisions are negligible → no uniqueness-enforcement primitive needed. On
  the paid tier the founder can rename it to a custom username (e.g. `acme`).
- **`{siteId}`** — chosen by the agent at publish time (e.g. `myblog`); may contain hyphens.
  One user hosts many sites, each on its own `{username}-{siteId}` subdomain. Combined length
  is capped (username ≤ 30, siteId ≤ 32) so the label fits the 63-octet DNS limit.

**Custom domain.** `https://status.acme.com` maps to a specific site via a `_domains/{host}`
record in R2. Routing + TLS come from adding the domain as a zone in the admin's account
and attaching the Worker as a Custom Domain — no Cloudflare for SaaS, no fallback origin.

### Asset paths — the win of the subdomain scheme

Because each site is the **root of its own subdomain**, both root-absolute and relative
asset references resolve correctly with no rewriting:

- `<link href="/css/app.css">` → `{username}-{siteId}.agenthost.page/css/app.css` ✅
- `<link href="./css/app.css">` → resolves relative to the page ✅

The Worker injects **no `<base>` tag** for plain HTML (sites serve like normal static
hosting). The markdown shell keeps `<base href="/">` because its sidebar links are
site-root-relative.

---

## 4. Data model (R2 only)

```
sites/{username}/{siteId}/{path}        # current static files, OVERWRITTEN IN PLACE (no history)
sites/{username}/{siteId}/_gen          # tiny pointer object; body = integer "deploy generation"
sites/{username}/{siteId}/_meta         # JSON: { createdAt, lastDeployAt, bytes, fileCount, keyHash, public }
_users/{username}                       # JSON, see below
_domains/{host}                         # JSON: { username, siteId }  (paid custom domains)
```

`_meta` is the per-site bookkeeping the **retention sweep** and **per-user quota** read
(§9). User usage is *derived* by summing each site's `_meta.bytes` — there is no mutable
usage counter (we have no Durable Object for atomic increments, so summing the source of
truth avoids a race; a small over-shoot from concurrent deploys is acceptable and
self-corrects next publish).

**Overwrite-in-place, with a deploy generation for cache invalidation.** Files are written
to a stable key and overwritten on redeploy (only the current copy is stored — no version
history). A per-site `_gen` integer bumps on every deploy and is embedded in the **Cache
API key** (never in the public URL), so a new deploy instantly orphans all old cached
entries — globally, with no purge API. See §6.

> **Trade-off (accepted):** no instant rollback (no history kept — to revert you
> re-publish), and a short non-atomic window during overwrite (a cache miss mid-deploy may
> serve partly-new files). Mitigated by deploy order: overwrite all files → delete orphans
> → only then bump `_gen`.

`_users/{username}` JSON:

```jsonc
{
  "tokenHash": "sha256(ownerToken)",   // the secret itself is never stored
  "email": "you@x.com",                // optional, unverified contact (set on claim)
  "plan": "free" | "paid",             // only the admin changes this
  "customDomain": "status.acme.com",   // optional, admin-registered
  "createdAt": 1718800000
}
```

Per-file R2 `httpMetadata`:

```
contentType   = guessed from extension at upload (serving does zero lookups)
```

(Browser caching is handled at serve time with `no-cache` + `ETag`, not stored on the
object — see §6 — because the public key is overwritten in place.)

**Why no DO/KV/D1:** the only hot-path query is `key → bytes`, which R2 serves with strong
consistency. The `_gen` pointer is a per-owner R2 object (last-writer-wins is fine — you
own your own site, there's no shared contended namespace). Username uniqueness is moot
because usernames are auto-generated with entropy.

---

## 5. Publish flow

**Canonical, zero-install command an agent runs:**

```bash
tar czf - -C ./dist . | curl -s --data-binary @- \
  https://agenthost.page/publish
```

**Server steps (`POST agenthost.page/publish`):**

0. **Detect the body** (`src/sniff.ts`). Peek the first 1 KB *without consuming it* (the
   peeked bytes are replayed ahead of the rest, so the stream stays intact) and branch on
   what's actually there: gzip (`1f 8b`) or tar (`ustar`) magic → archive; otherwise a
   single document, front matter → markdown and a doctype/markup opener → html. The
   `Content-Type` header is only a tiebreaker — clients send nothing, `octet-stream`, or
   curl's `x-www-form-urlencoded` far more often than the truth, and trusting it used to
   push a perfectly good `.md` down the untar path to die as "bad archive". An explicit
   `?file=<name>` still wins outright, and non-archive *binary* is rejected up front rather
   than published as a document.
1. **Resolve account.** No `Authorization` → generate a memorable `username`; create
   `_users/{username}` and mint an `ownerToken` (random 32 bytes; store only its
   `sha256`). With `Authorization: Bearer <ownerToken>` → verify against
   `_users/{username}.tokenHash`. Redeploys hit the same URL.
2. **Resolve `siteId`** from the request (agent-chosen; default if omitted).
3. **Compute the effective size budget.** Read the user's `plan` and sum the other sites'
   `_meta.bytes` (`R2.list` the user prefix). Effective cap for this deploy =
   `min(perSiteCap, userQuota − usageOfOtherSites)` (see §9 for the numbers). This makes the
   per-user quota fail *fast* during the stream rather than after.
4. **Stream-untar to R2.** Pipe the body through `DecompressionStream('gzip')` + a
   streaming tar parser; write each entry **straight** to
   `sites/{username}/{siteId}/{path}` (overwrite-in-place) with **bounded concurrency (≤6
   in-flight puts)** so the 128 MB per-isolate memory limit is never threatened. **Never
   buffer the whole archive.** Tally total bytes + file count as you go. Reject: paths
   containing `..`, symlinks, files over the per-file cap, file count over the cap, or total
   over the effective budget from step 3.
5. **Delete orphans.** `R2.list` the site prefix and delete keys present in the previous
   deploy but absent from this one (so removed files actually disappear).
6. **Write `_meta`** `{ createdAt (preserve), lastDeployAt: now, bytes, fileCount, keyHash,
   public }`. On **first** publish, generate the access key and store `sha256(key)` as
   `keyHash` (default `public: false`); on redeploy, preserve `keyHash`/`public` so existing
   share links keep working. `lastDeployAt` is what the retention sweep reads.
7. **Bump generation.** Read `sites/{username}/{siteId}/_gen`, write `gen + 1`. Done last,
   so cache invalidation flips only after all bytes are in place. R2 read-after-write is
   strong → the new generation is visible immediately (preserves the publish→verify loop).
8. **Respond 200 JSON:**

   ```json
   { "url": "https://cleverotter4f2-myblog.agenthost.page/",
     "shareUrl": "https://cleverotter4f2-myblog.agenthost.page/?k=<access-key>",
     "username": "cleverotter4f2",
     "siteId": "myblog",
     "generation": 2,
     "accessKey": "<shown once — sites are private; share via shareUrl>",
     "ownerToken": "<shown once — save to redeploy>" }
   ```

   `shareUrl` is what the agent hands to a human — it logs them in on first visit. `url` is
   the bare (gated) URL. On redeploys, `accessKey`/`ownerToken` aren't re-shown.

**One publish path only.** Everything-in-one-POST is THE contract — no per-file PUT path, no
multi-request session. The body is either a tar or one document, and step 0 decides which
from the bytes; the caller never has to declare it.

---

## 6. Serve flow

Worker on `*.agenthost.page/*` (and custom-domain hosts), `run_worker_first` enabled:

1. Parse `Host`:
   - apex `agenthost.page` / `www` → landing page + `/publish` + `/llms.txt` (Static Assets
     + endpoints).
   - `*.workers.dev` → admin surface, behind Cloudflare Access (§8).
   - `{username}-{siteId}.agenthost.page` → split on the **first** hyphen (usernames are
     hyphen-free) → `{username, siteId}`; it's a site request.
   - any other host → look up `_domains/{host}` in R2 → `{username, siteId}` (paid custom
     domain).
2. The path is the file path within the site (`{rest}`); `siteId` came from the Host, not
   the path.
3. Read `sites/{username}/{siteId}/_gen` → `gen` (strongly consistent; itself short-TTL
   edge-cacheable if needed).
4. Map path: `/` and `/dir/` → `index.html`. R2 key is `sites/{username}/{siteId}/{rest}`.
5. **Cache check:** `cache.match` on a synthetic, generation-pinned key
   `cache://{username}/{siteId}/g{gen}/{rest}` (the `gen` is in the *cache* key, never the
   public URL). Hit → return. Because the key embeds `gen`, a deploy bumping `gen` orphans
   every old entry globally — no purge API, no mixed assets.
6. **Miss:** `R2.get(key, { onlyIf, range })` so R2 natively emits `304`/`206`. Miss →
   try `{rest}/index.html`, else the site's `404.html`, else a generic 404. Set
   content-type + `ETag` from `writeHttpMetadata`; respond with `Cache-Control: no-cache`
   so browsers revalidate (cheap `304`s against the gen-keyed edge cache). No `<base>` is
   injected for plain HTML (each site is its own subdomain root). `cache.put`, return.

**`noindex` on all hosted sites.** Every response served from a user subdomain or custom
domain carries `X-Robots-Tag: noindex, nofollow`. Hosted sites are never indexed — this
protects the apex domain's search reputation from spam/phishing content. **Only the landing
page** (apex `agenthost.page`) is indexable. There is no per-site opt-in to indexing in the
MVP.

**`/llms.txt`** is served at the apex (`agenthost.page/llms.txt`) — a machine-readable
description of how to publish, so any agent that lands on the domain can self-serve. (This
is the apex/landing surface, distinct from a site's own files.)

**Rollback:** not instant — no history is kept (overwrite-in-place). To revert, re-publish
the previous build.

**Takedown:** the admin writes a tombstone marker → serving returns 410.

---

## 6.5 Private by default — access control

Every hosted site is **private by default**, gated by a per-site **access key** (the
"password"). Only the apex (landing, `/llms.txt`, `/publish`, `/admin`) is public.

**Key model.** On first publish the Worker generates a per-site access key — a **medium
alphanumeric code (~8–10 chars)**, typeable in the prompt and short enough for a URL; it
stores only `sha256(key)` in `_meta.keyHash` and returns the key **once** in the publish
response,
along with a ready-made **share URL**:
`https://{username}-{siteId}.agenthost.page/?k=<key>`. The key **persists across redeploys**
(shared links keep working). The owner (with `ownerToken`) can **rotate** it (invalidates
old links) or flip `_meta.public = true` to drop the gate entirely.

**Authorization — runs before §6 serve:**
1. **Valid auth cookie** for this site → authorized, serve.
2. Else **`?k=<key>`** present and `sha256(k) === keyHash` → set an auth cookie scoped to
   the site's subdomain (`Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age` ~1y), then **302 to
   the same URL minus `?k`** so the key doesn't linger in history/referrer. The next request
   carries the cookie → authorized. *(This is the "enters once, stays in" requirement.)*
3. Else → serve our **password interstitial**: a small branded HTML page with an input;
   submitting re-tries via `?k`. Wrong key → re-prompt. *(This is the "no key in URL →
   manual prompt" requirement.)*

So a shared link logs the visitor in once and the cookie keeps them in; a bare visit
prompts. `public` sites skip all of this.

**Injected share widget.** On every authorized **`text/html`** response the Worker injects
(via `HTMLRewriter`, appended before `</body>`) a tiny script + a floating **"Share"**
button in a corner. The Worker knows the key at serve time (it validated the cookie/param),
so it **bakes the share URL into the injected script** — the button just copies
`https://{username}-{siteId}.agenthost.page/?k=<key>`. The auth cookie stays `HttpOnly`; the button never needs to read it.
Only HTML is rewritten; other assets pass through untouched.

> **This feature is the concrete reason origin isolation matters** (see §6.6): auth cookies
> and the injected key live on the host serving untrusted user HTML. They must be isolated
> from the control plane (admin/publish).

---

## 6.6 Control-plane isolation (decision needed)

**Control plane** = the privileged surfaces (the **admin** console and the **publish/manage
API**) — they hold secrets and can mutate state. **Data plane** = the **untrusted user
sites** we serve (arbitrary HTML/JS we didn't write).

The risk of co-locating them: serving user content on subdomains of the *same registrable
domain* as the control plane (`*.agenthost.page` while admin/publish are on `agenthost.page`)
lets a malicious site attack the control plane via the shared parent domain — e.g. writing a
`Domain=.agenthost.page` cookie (cookie injection / session fixation), or other same-site
assumptions. The cookie-based private-access feature (§6.5) makes this sharper, since auth
now rides on those hosts.

**Industry-standard fix:** serve untrusted content from a separate registrable domain
(GitHub → `githubusercontent.com`, CodePen → `cdpn.io`). The full version of that would also
move hosted user sites off `agenthost.page`.

**DECIDED (Open Q #6):** we do **not** register a separate content domain. Instead:

- **Admin → the Worker's default `*.workers.dev` host**, behind Cloudflare Access. This is a
  different registrable domain from `agenthost.page`, so nothing a user site does with
  `Domain=.agenthost.page` cookies can reach the admin. This isolates the highest-value
  control surface for free.
- **Publish API stays on `agenthost.page`** but is **token-based (Authorization header, not
  cookies)**, so cookie injection from user content can't compromise it.
- **Hosted user sites + landing stay on `agenthost.page`.** Accepted residual risk: a
  malicious site could set a `Domain=.agenthost.page` cookie that reaches sibling user sites.
  This is **low-impact by design**: the §6.5 gate validates the cookie value against each
  site's `keyHash`, so a forged/fixed cookie that doesn't equal the real key simply fails
  and falls through to the prompt — it cannot forge access to another site. We document it
  and move on; a content sandbox domain remains an easy future hardening if needed.

---

## 6.7 Markdown rendering (GitBook-style)

Agents can upload **`.md`** files. When a request resolves to a markdown file, the Worker
renders it server-side into our **GitBook-style** shell instead of serving raw text:

- **Render at serve time** with a `workerd`-safe pure-JS markdown lib (e.g. `marked`),
  wrapped in our template: a left **sidebar** listing the site's other `.md` files + the
  rendered content on the right. Result is cached under the same gen-keyed Cache API entry,
  so it's only rendered once per deploy.
- **Sidebar / menu** = `R2.list` the site prefix, filter to `*.md`, build a nav tree. If the
  site ships a **`SUMMARY.md`** (GitBook convention), honor its ordering; otherwise sort by
  path. The set of `.md` files changes per deploy → `_gen` bump invalidates the cache.
- **Default doc:** for a markdown-only site, `/` renders `README.md` (or the first entry in
  `SUMMARY.md`) so the root is the docs home.
- **Mixed sites just work:** `.html` is served as-is (§6); only `.md` gets the renderer. The
  `<base>` rewrite, the share widget (§6.5), `noindex`, and the private gate all still apply
  to the rendered page (it's our HTML).
- **Raw access** via `?raw` returns the unrendered markdown.
- Markdown may embed raw HTML; since sites are private and origin-isolated (§6.6) this is
  low-risk, but sanitizing is an easy optional hardening.

This turns "drop a folder of `.md`" into an instant hosted docs site with navigation — no
build step on the agent's side.

---

## 7. Ownership, claim & tiers

Three tiers, friction-zero default, founder-gated upgrades:

| | **Free** | **Paid** (admin enables) |
|---|---|---|
| URL | `{auto}-{id}.agenthost.page` | + **custom username** |
| Custom domain | — | `status.acme.com` (admin-registered) |
| Publish / serve | full | full (identical) |
| Retention | 15 days since last publish | infinite |
| Quota | 250 MB/site, 500 MB/account | 1 GB/site, ~unlimited account |

- **Anonymous (default).** Publish returns `ownerToken` once (stored only as a hash).
  Redeploy to the same URL by sending `Authorization: Bearer <ownerToken>`. The publish
  response prints it with a "save this to redeploy" note. Token loss = publish a new URL
  (documented plainly).
- **Claim (optional, free).** Attach an email as recovery/abuse contact (unverified
  string in v1).
- **Paid (founder enables via admin).** Custom username (rename, one `R2.head` collision
  check) and/or custom domain (a `_domains` mapping + one-time dashboard zone/Custom Domain).

---

## 8. Admin

A thin, founder-operated surface — **not** a multi-user dashboard.

- Lives **in the same Worker**, served on **`admin.agenthost.page`** — an Access-protected
  hostname in our own zone (control-plane isolation, §6.6). Routing: `Host === admin.` +
  `APEX_HOST` → admin surface (Static Assets UI + JSON routes).
- **Auth = Cloudflare Access**, configured in the dashboard to allow only the operator's
  email (`ALLOWED_ADMIN_EMAIL`). The Worker verifies the signed Access JWT
  (`Cf-Access-Jwt-Assertion`) as defense-in-depth — no hand-rolled auth.
- **Operations** (all behind Access): list users/sites (`R2.list` on `_users/` and
  `sites/{username}/`), set `plan`, rename a username, attach a custom domain (writes
  `_domains/{host}` + returns the dashboard checklist), and take down an abusive site. Each
  is a JSON edit in R2.
- Scales fine on `R2.list` at low volume; D1 can back the admin later if listing grows —
  additive, never touches the hot path.

---

## 9. Limits, quotas, retention & abuse (MVP)

### Limits & quotas (all tunable)

| Limit | Free | Paid |
|---|---|---|
| Per file | 5 MB | 25 MB |
| Files per site | 50 | 1000 |
| Size per site | 250 MB | 1 GB |
| **Total per user** | **500 MB** | effectively unlimited |
| **Retention** | **15 days** since last publish | **infinite** |

Per-file / per-site / file-count caps are enforced **during the untar stream** (fail fast,
§5 step 4). The per-user total is enforced by folding it into the effective size budget
(§5 step 3) — derived from per-site `_meta.bytes`, no mutable counter.

### Retention sweep (cron)

A **Cron Trigger** on the same Worker runs nightly and deletes free-tier sites whose
`_meta.lastDeployAt` is older than 15 days — keeping R2 from bloating with abandoned sites.
Redeploying resets the clock (`lastDeployAt` bumps every publish). **Paid users
(`plan === "paid"`) are skipped — infinite retention.** Deleting a site = `R2.list` its
prefix + delete all keys (files, `_gen`, `_meta`); the empty `_users/{username}` record is
left in place (tiny). The sweep is `O(sites)` via `R2.list` — fine at low scale; a D1 index
makes it `O(expired)` later if needed.

### Abuse

Public-by-default publishing means day-one abuse risk. Controls, **no Durable Object**:

- **`X-Robots-Tag: noindex`** on all hosted sites (§6) so spam/phishing can't ride the
  domain's search reputation.
- **Cloudflare Rate Limiting Rules (WAF)** on `/publish` — zone-level, zero code.
- **Size/count/quota caps** (above), enforced during untar.
- **Takedown** endpoint in the admin (§8).
- Turnstile deferred.

---

## 10. Monorepo layout

**Tooling:** **pnpm** (latest) workspaces · **Turborepo** (latest) for task orchestration ·
TypeScript · **Hono** in the Worker · **Astro** for the landing · **Svelte** for the admin ·
Wrangler to deploy. The landing and admin are each built to static output and copied into
`public/`, which the Worker serves via Static Assets — so it's still **one `wrangler
deploy`**. No test framework, linter, or formatter — kept deliberately lean.

```
agenthost/
├─ package.json                 # workspace root; turbo pipeline (build → copy → deploy)
├─ pnpm-workspace.yaml
├─ turbo.json                   # build/deploy task graph across packages
├─ worker/                      # (2) THE BACKEND — the entire server (Hono on Workers)
│  ├─ src/index.ts              # Hono app: apex→landing/publish/admin ; *→serve ; custom-domain→serve
│  ├─ src/publish.ts            # streaming untar → bounded R2 puts → delete orphans → bump _gen
│  ├─ src/serve.ts              # host→username, read _gen, gen-keyed Cache API, R2 get, <base> inject
│  ├─ src/admin.ts              # admin JSON routes (Hono sub-router, behind Cloudflare Access)
│  ├─ src/ids.ts                # username gen, reserved-word denylist, content-type guess
│  ├─ src/tar.ts                # streaming gzip+tar reader (no full buffering)
│  ├─ src/sniff.ts              # peek the first 1 KB → archive vs md vs html (Content-Type optional)
│  └─ wrangler.jsonc            # r2=SITES; assets binding + run_worker_first; routes; cron
├─ landing/                     # (1) LANDING PAGE for agents — Astro, static build → landing/dist
│  └─ src/pages/index.astro     #   the one-liner + curl contract
├─ skills/agenthost/           # (3) THE SHAREABLE SKILL (Agent Skill layout)
│  ├─ SKILL.md                  #   agent-readable; name + description frontmatter
│  └─ references/http-api.md    #   full HTTP publish contract
├─ admin/                       # (4) ADMIN UI — Svelte (Vite SPA), static build → admin/dist
│  └─ src/App.svelte            #   founder dashboard; talks to worker /admin JSON routes
├─ public/                      # build output: landing/dist → / , admin/dist → /admin (ASSETS)
└─ README.md
```

One deployable. The build copies `landing/dist` and `admin/dist` into `public/`; the Worker
serves both via Static Assets and routes everything else by Host.

**Contract & types:** the API is defined once as a shared zod schema (validation +
inferred types + optional OpenAPI/MCP schema), and the Worker exports its Hono `AppType` so
the admin consumes it via the typed `hc` client — no codegen, contract drift caught
at build time. Dev runs local-first against Miniflare-simulated R2/Cache.
