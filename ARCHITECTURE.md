# agenthost — Architecture

> Hosting **built for AI agents**. An agent publishes a page, docs or any files as a
> **share** and gets back a private share URL. Zero signup, zero key
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

- **Workers** — the only compute. One script: routes by `Host`. Apex → landing / shares API.
  `*.agenthost.page` → serve a share. `*.workers.dev` → admin (behind Access). Custom domain →
  serve a site. One deploy.
- **R2** — the only byte store. One bucket holds every file of every version of every
  site, plus tiny metadata objects. **Read-after-write is strongly consistent per object**
  — this is what lets us drop Durable Objects/KV.
- **Workers Static Assets** — serves the landing page and the admin UI from the same
  Worker on the apex host (`run_worker_first` so the Worker routes by Host first).
- **Cache API + CDN** — edge-caches served bytes keyed by the generation-pinned cache key
  (`cache://…/g{gen}/{path}`), so committing a new generation on publish instantly orphans old entries —
  no purge API, no mixed assets.
- **Cloudflare Access** — founder-only auth in front of the admin (`*.workers.dev` host).
  Zero auth code.
- **Custom domains (no paid tier)** — bring-your-own-domain (`status.acme.com`) is a
  free `_domains/{host}` mapping in R2 plus a one-time dashboard step: the admin adds
  the domain as a zone and attaches the Worker as a Custom Domain (free routing + TLS).
  No Cloudflare for SaaS. Trade-off: the customer's zone lives in the admin's account.
- **Rate limiting** — per-IP Workers rate-limit bindings on publishes and uploads. No DO.
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

The Worker injects **no `<base>` tag** anywhere (sites serve like normal static hosting).
The markdown shell used to carry `<base href="/">` so that its site-root-relative sidebar
links would work from a nested page — which also re-based every relative link *inside* a
nested document to the site root. The sidebar now emits root-absolute, percent-encoded
hrefs (`/guide/intro.md`), so `[api](./api.md)` in `guide/intro.md` resolves where the
author meant.

---

## 4. Data model (R2 only)

```
sites/{username}/{siteId}/{path}        # a share's files, OVERWRITTEN IN PLACE (no history)
_sites/{username}/{siteId}             # { generation, createdAt, lastDeployAt, bytes, fileCount, accessKey, public, tombstone?, pending? }
_users/{username}                       # JSON, see below
_domains/{host}                         # JSON: { username, siteId }  (paid custom domains)
```

**A share is one tree of files.** A page, a docs folder, a single video and a dataset are
the same thing; what `/` shows is decided at serve time (§6). There used to be a separate
"asset" kind (own records, own URLs on the apex, own key gate, no redeploy, no rotation).
The only real difference was how the bytes arrive, so that is all that stayed different
(§5). The storage prefixes kept the name `sites/` because renaming them is a bucket-wide
copy that buys nothing.

The share record is the per-share bookkeeping the **retention sweep** and **per-user quota**
read (§9). User usage is *derived* by summing each share's `bytes` plus its `pending` upload
reservations — there is no mutable
usage counter (we have no Durable Object for atomic increments, so summing the source of
truth avoids a race; a small over-shoot from concurrent deploys is acceptable and
self-corrects next publish).

**Overwrite-in-place, with a deploy generation for cache invalidation.** Files are written
to a stable key and overwritten on redeploy (only the current copy is stored — no version
history). A per-site `generation` integer bumps on every publish and is embedded in the **Cache
API key** (never in the public URL), so a new deploy instantly orphans all old cached
entries — globally, with no purge API. See §6.

> **Trade-off (accepted):** no instant rollback (no history kept — to revert you
> re-publish), and a short non-atomic window during overwrite (a cache miss mid-deploy may
> serve partly-new files). Mitigated by deploy order: overwrite all files → delete orphans
> → only then commit generation and access metadata together.

`_users/{username}` JSON:

```jsonc
{
  "tokenHash": "sha256(secret)",       // ownerToken is "{username}.{secret}"; the secret is never stored
  "email": "you@x.com",                // optional, unverified contact (PATCH /account)
  "plan": "free" | "paid",             // only the admin changes this
  "customDomain": "status.acme.com",   // optional, admin-registered
  "createdAt": 1718800000
}
```

**Compact, directly listable metadata.** Small control records (shares, users and
custom domains) store their JSON once in R2 `customMetadata.json` with an empty body.
`R2.list({ include: ["customMetadata"] })` returns these records without per-object GETs.
Every record must fit R2's metadata limit; the free-form fields are the email (≤ 254
characters) and pending upload paths (≤ 512 characters, at most one per file a share
may hold). The same PUT maintains the object and its index; there is no
second index object or paid database.

Older layouts (nested `sites/{u}/{s}/_meta` + `_gen`, JSON bodies, `legacySiteIds`) were
migrated in one pass on 2026-10-18 and are no longer read. The accepted
overwrite-in-place/concurrent-publish quota limitations still apply.

Per-file R2 `httpMetadata`:

```
contentType   = guessed from extension at upload (serving does zero lookups)
```

(Browser caching is handled at serve time with `no-cache` + `ETag`, not stored on the
object — see §6 — because the public key is overwritten in place.)

**Why no DO/KV/D1:** the only hot-path query is `key → bytes`, which R2 serves with strong
consistency. The merged metadata/generation record is a per-site R2 object (last-writer-wins is fine — you
own your own site, there's no shared contended namespace). Username uniqueness is moot
because usernames are auto-generated with entropy.

---

## 5. Writing a share

Two ways in, because the physics differ: a request body through the Worker is cheap,
streamable and capped at ~100 MB by the zone; a 5 GB video can't take that path.
Both write files into the same tree and commit the same record.

| | Body through the Worker | Presigned upload |
|---|---|---|
| Call | `PUT /shares/{id}` or `PUT /shares/{id}/files/{path}` | `POST …/uploads/prepare/{path}` → R2 PUT → `POST …/uploads/complete/{path}` |
| Carries | a tar or one document; or one file at a path | one file at a path |
| Semantics | `replace` (default, deletes orphans) or `?mode=merge`; `/files/` always merges | always merges |

A file is always named by the URL path, never by a query (`?file=`), a body field or
`Content-Disposition`. Each of those once existed somewhere; one rule leaves an agent
nothing to guess. Bodies carry data, the query carries options (`mode`, `cursor`).

**Canonical, zero-install command an agent runs:**

```bash
tar cf - -C ./dist . | curl -s -X PUT --data-binary @- https://agenthost.page/shares/myblog
```

**Server steps (`PUT /shares/{id}`):**

0. **Detect the body** (`src/sniff.ts`). Peek the first 1 KB *without consuming it* (the
   peeked bytes are replayed ahead of the rest, so the stream stays intact) and branch on
   what's actually there: gzip (`1f 8b`) or tar (`ustar`) magic → archive; otherwise a
   single document, front matter → markdown and a doctype/markup opener → html. The
   `Content-Type` header is only a tiebreaker — clients send nothing, `octet-stream`, or
   curl's `x-www-form-urlencoded` far more often than the truth, and trusting it used to
   push a perfectly good `.md` down the untar path to die as "bad archive". A path from
   `PUT /shares/{id}/files/{path}` wins outright (a tar there is stored as a file), and on
   `/shares/{id}` non-archive *binary* is rejected up front rather than published as a
   document.
1. **Resolve account.** No `Authorization` → generate a memorable `username`; create
   `_users/{username}` and mint a secret (random 32 bytes; store only its `sha256`). The
   agent gets `ownerToken = "{username}.{secret}"`: one string both names and proves the
   account (usernames never contain a dot), so no call needs a separate `?username=`.
2. **Resolve the share id** from the path; it's sanitized and required.
3. **Compute the effective size budget.** Read the user's `plan`, sum the other shares'
   `bytes` and pending reservations from one `_sites/{username}/` LIST, and list this
   share's files. Budget = `min(perShareCap, userQuota − otherShares) − ownPending`. A merge
   starts its tally from the files already there and subtracts a file it overwrites, so
   the count is exact rather than conservative. This makes the quotas fail *fast* during
   the stream rather than after.
4. **Stream-untar to R2.** Pipe the body through native `node:zlib` gunzip (not
   `DecompressionStream`, which rejects bsdtar's zero-padding after the member and drops
   the archive's tail) + a streaming tar parser; stream each
   entry **straight** to `sites/{username}/{siteId}/{path}` (overwrite-in-place) through a
   `FixedLengthStream`, its bytes as slices of the input chunks, with **bounded concurrency
   (≤3 in-flight puts)**. **Never buffer the whole archive, nor a whole file:** memory stays
   flat, and on the Free plan's ~10 ms CPU budget the Worker can't afford to touch the
   bytes. A bare tar skips inflation entirely, the cheapest path for large or
   already-compressed payloads. Reject: paths containing `..`, symlinks, files over the
   per-file cap, file count over the cap, or total over the effective budget from step 3.
5. **Delete orphans** (replace only): files in the step-3 listing this publish didn't
   write. Paths with an upload in flight are left alone.
6. **Commit `_sites/{username}/{siteId}`** `{ generation: previous + 1, createdAt (preserve),
   lastDeployAt: now, bytes, fileCount, accessKey, public, tombstone?, pending? }`. The
   first write of a share mints the access key (`public: false`); later writes preserve key
   and visibility so links keep working. `lastDeployAt` is what the retention sweep reads.
7. **Respond 200 JSON:**

   ```json
   { "url": "https://cleverotter4f2-myblog.agenthost.page/?k=<access-key>",
     "id": "myblog",
     "username": "cleverotter4f2",
     "fileCount": 12,
     "bytes": 48213,
     "ownerToken": "<only when this call created the account>" }
   ```

   One link, nothing to choose: `url` always carries the key (unless the share is public),
   on every write and on `GET /shares/{id}`.

### 5.5 Presigned uploads

1. `POST /shares/{id}/uploads/prepare/{path}` sends only `{bytes, contentType?}`. The Worker checks the
   per-file cap and the share/account budget — a file already at `path` is replaced, so its
   size is credited back — records `pending[path] = {bytes, expiresAt}` on the share record
   (creating the share if new), and returns a 15-minute presigned PUT for the file's final
   key with exact signed `Content-Length` and `Content-Type`.
2. The caller PUTs the payload **directly to `<account>.r2.cloudflarestorage.com`**. No bytes
   cross the Worker. The signed length keeps the URL from exceeding the reservation; the URL
   is scoped to one key.
3. `POST /shares/{id}/uploads/complete/{path}` (no body) `R2.head`s the object, checks its size (a mismatch
   deletes it), recounts the tree from one LIST, drops the reservation and bumps the
   generation.

The PUT lands on the live key, before completion. A reader who misses the cache in that
window gets the new file a little early — the same non-atomic window publish already
accepts; staging plus a server-side copy would double the writes of a 5 GB file to close
it. An upload never completed is deleted by the sweep, with its reservation, after a day.
Presigning needs a bucket-scoped R2 S3 key as Worker secrets. R2 caps a single PUT at 5 GB,
which is the paid per-file cap.

### 5.6 The rest of the API

`GET /shares`, `GET|PATCH|DELETE /shares/{id}`, `POST /shares/{id}/key` (rotate),
`PUT|DELETE /shares/{id}/files/{path}`, `PATCH /account`. REST over the old query-string
endpoints was chosen alongside the hard cut to shares: with every client breaking anyway,
the churn cost nothing.

---

## 6. Serve flow

Worker on `*.agenthost.page/*` (and custom-domain hosts), `run_worker_first` enabled:

1. Parse `Host`:
   - apex `agenthost.page` / `www` → landing page + `/shares` API + `/llms.txt` (Static
     Assets + endpoints).
   - `*.workers.dev` → admin surface, behind Cloudflare Access (§8).
   - `{username}-{siteId}.agenthost.page` → split on the **first** hyphen (usernames are
     hyphen-free) → `{username, siteId}`; it's a share request.
   - any other host → look up `_domains/{host}` in R2 → `{username, siteId}` (paid custom
     domain).
2. The path, percent-decoded, is the file path within the share (`{rest}`); `siteId` came
   from the Host. Files are stored under their decoded names, so `/a%20b.pdf` is `a b.pdf`.
3. Read the authoritative site record fresh: **one R2 GET** for generation, takedown and
   access state, never cached. Check access and takedowns before consulting route/content
   caches or returning a conditional 304.
4. Map path: `/` and `/dir/` → `index.html`; `/dir` tries the exact file before
   `/dir/index.html`. A Markdown-only homepage uses the first valid SUMMARY entry,
   README, or the first document. With neither, `/` is the **file index**: a preview of
   the only file (video, audio, image and PDF inline) or a list of all of them, each with
   a `?download` link — this is what replaced the old asset download page. Successful
   resolutions are edge-cached under
   `https://as-routes.internal/{username}/{siteId}/g{gen}/r{RENDER_VERSION}/{rest}`.
   Cold GET requests retain the fetched object for serving, removing HEAD-then-GET.
   HEAD requests probe metadata only. Warm route caching avoids repeated file probes.
   Misses are not cached. Only the resolved filename is stored; no access keys or
   access decisions. The separate cache host prevents collisions with share files, and
   paths are re-encoded in both cache URLs so a `?` or `#` in a filename can't split them.
5. **Cache check:** `cache.match` on a synthetic, generation-pinned key
   `cache://{username}/{siteId}/g{gen}/{rest}` (the `gen` is in the *cache* key, never the
   public URL). Hit → return. Because the key embeds `gen`, a deploy bumping `gen` orphans
   every old entry globally — no purge API, no mixed assets. A **rendered** markdown page
   or file index gets one extra segment, `/r{RENDER_VERSION}`: the bytes of a static file belong to the
   site, but that HTML belongs to *our* renderer, and `gen` only moves when the site
   republishes. Without it, shipping a renderer change would reach only sites that happen
   to publish again (`config.ts` — bump it when the markdown output changes).
6. For static files (including raw Markdown), pass range and revalidation headers
   to `cache.match`: Cloudflare can return `304`/`206` directly from the edge. Store
   `ETag`, `Last-Modified`, and `Content-Length` with full responses to support this.
   Objects over 512 MB (the Cache API's limit) are never put: they stream from R2 on every
   request, ranges included, so a 5 GB video seeks fine. Workers impose no response size
   limit; this costs one invocation per range request, and was preferred over presigned
   GETs because it keeps one URL per file that works in `<video src>` and behind the
   share's own key gate.
   **Miss:** `R2.get(key, { onlyIf, range })` handles the same conditions. Legacy cache
   entries without the required headers also fall back to R2. Partial/conditional
   responses never overwrite the cached full object. Unresolved routes use the site's
   `404.html`, else a generic 404. Client responses use `Cache-Control: no-cache`.
   Published HTML and cached rendered Markdown stream through `HTMLRewriter`; only
   uncached Markdown needs full text for parsing. Cache the undecorated body and inject
   the Share widget/live-reload script per request. No `<base>` is injected.
7. `?download` serves any file — HTML and Markdown included — as itself with
   `Content-Disposition: attachment`; `?raw` serves Markdown source as plain text. Both
   are set after the cache, so one entry serves every variant.

Warm requests still pay for the two fresh control-object reads, but no file-resolution
R2 operations. The serving regression tests enforce these storage-operation budgets:

| Warm request | Before | After |
| --- | ---: | ---: |
| Static asset | 3 | 2 |
| Directory HTML at `/dir` | 4 | 2 |
| Markdown homepage with SUMMARY | 5 | 2 |
| Static asset revalidation / range | 4 | 2 |

These are operation counts, not production latency measurements. Run
`pnpm -C worker exec vitest run test/serve-performance.test.ts` to check the budgets,
generation invalidation, access changes, streaming, and conditional-cache delegation.

**`noindex` on all shares.** Every response served from a user subdomain or custom
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

Every share is **private by default**, gated by a per-share **access key** (the
"password"). Only the apex (landing, `/llms.txt`, the API, `/admin`) is public.

**Key model.** A share's first write generates its access key — a **medium alphanumeric
code (~8–10 chars)**, typeable in the prompt and short enough for a URL — and every response
returns a ready-made **share URL**: `https://{username}-{siteId}.agenthost.page/?k=<key>`.
The key **persists across writes** (shared links keep working). The owner can **rotate** it
(invalidates old links) or set `public: true` to drop the gate entirely.

The key is **stored as is**, not hashed. A hash protected nothing: anyone able to read the
record can read the files it guards, and the key exists to travel in URLs. Storing it lets
every response (and `GET /shares/{id}`) hand the link back, where the hash made agents
keep the first publish's link or rotate. The owner token, which does guard writes, stays
hashed. Records written before this kept only `keyHash`; the gate still accepts those, and
rotating replaces the hash with a stored key.

**Authorization — runs before §6 serve:**
1. **Valid auth cookie** for this site → authorized, serve.
2. Else **`?k=<key>`** present and equal to the share's key → set an auth cookie scoped to
   the site's subdomain (`Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age` ~1y), then **302 to
   the same URL minus `?k`** so the key doesn't linger in history/referrer. The next request
   carries the cookie → authorized. *(This is the "enters once, stays in" requirement.)*
3. Else → serve our **password interstitial**: a small branded HTML page with an input;
   submitting re-tries via `?k`. Wrong key → re-prompt. *(This is the "no key in URL →
   manual prompt" requirement.)*

So a shared link logs the visitor in once and the cookie keeps them in; a bare visit
prompts. `public` shares skip all of this.

**Injected share widget.** On every authorized **`text/html`** response the Worker injects
(via `HTMLRewriter`, appended before `</body>`) a tiny script + a floating **"Share"**
button in a corner. The Worker knows the key at serve time (it validated the cookie/param),
so it **bakes the share URL into the injected script** — the button just copies
`https://{username}-{siteId}.agenthost.page/?k=<key>`. The auth cookie stays `HttpOnly`; the button never needs to read it.
Only HTML is rewritten; other assets pass through untouched.

> **This feature is the concrete reason origin isolation matters** (see §6.6): auth cookies
> and the injected key live on the host serving untrusted user HTML. They must be isolated
> from the control plane (admin/publish).

**Injected live reload.** Next to the Share widget, every served HTML page gets a small
script that polls **`/_gen`** and calls `location.reload()` when the site's version tag
(`g{gen}-r{RENDER_VERSION}`) changes. No morphing, no scroll bookkeeping: the browser
restores scroll natively on reload and the page's own JS starts clean, so the same
mechanism works on our markdown shell and on user-published HTML. Cost is the whole design:

- **Client polls rarely.** Only while the tab is visible, with an immediate check when it
  becomes visible again. Web Locks elect one visible tab per origin; BroadcastChannel
  distributes versions and a hidden/closed leader releases its lock. Older browsers keep
  independent polling. Fast cadence applies only during the five minutes after the last
  publish (the page carries `lastDeployAt`), then 60 seconds, then five minutes while idle.
  Exponential backoff applies on any
  error — an error never reloads. A pending reload waits for a text selection or a focused
  input to clear. Constants live in `LIVE` (`worker/src/config.ts`).
- **Server answers from a per-site edge micro-cache.** `/_gen` is public (a version tag
  reveals nothing the 401/404 pages don't) and handled before the access gate, so it never
  performs authorization or touches `ACCESS_LIMITER`. It reads the site record for its
  generation. The version sits in the Cache API for
  a few seconds, so R2 sees one read per site, per colo, per TTL regardless of readers.
  ETag/304 keeps the steady-state poll to a header exchange. Every poll is still one Worker
  invocation — that is the floor, and why the interval is long.
- **Detection latency is poll interval + TTL by design.** `cache.delete` on publish would
  only clear the publishing colo, so we don't pretend to invalidate.
- Pages opt out with `<meta name="agenthost-live" content="off">`.

---

**Rendering and browser revalidation budgets.** HTML validators hash the site generation,
renderer version, path, host and current access policy. Fresh authorization runs first;
a matching `If-None-Match` skips both rendering and the body-cache read. Decorated HTML
uses `Cache-Control: private, no-cache` because a share widget can contain the reader's
key. Static files retain native ETags, conditional responses and byte ranges.

The Markdown navigation index is cached once per generation and renderer version across
all pages; evicting a rendered body does not repeat the file listing or SUMMARY read.
Navigation membership uses sets rather than repeated linear searches. Highlighting is
limited to 2,048 characters per block and 4,096 across a document. Larger blocks remain
escaped, copyable code. Documents over 262,144 characters display escaped source in the
shell with a bounded preview and a link to the complete raw source. R2 bodies stop being
read once the preview limit is reached; oversized SUMMARY files fall back to filename
navigation. These are deliberate
CPU/latency tradeoffs and leave uploaded files and `?raw` downloads intact.

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
  share's key, so a forged/fixed cookie that doesn't equal the real key simply fails
  and falls through to the prompt — it cannot forge access to another site. We document it
  and move on; a content sandbox domain remains an easy future hardening if needed.

---

## 6.7 Markdown rendering (GitBook-style)

Agents can upload **`.md`** files. When a request resolves to a markdown file, the Worker
renders it server-side into our **GitBook-style** shell instead of serving raw text:

- **Render at serve time** with a `workerd`-safe pure-JS markdown lib (e.g. `marked`),
  wrapped in our template: a left **sidebar** listing the site's other `.md` files + the
  rendered content on the right. Result is cached under the same gen-keyed Cache API entry
  (plus `RENDER_VERSION`, §6), so it's only rendered once per deploy.
- **Sidebar / menu** = `R2.list` the site prefix, filter to `*.md`, build a nav tree. If the
  site ships a **`SUMMARY.md`** (GitBook convention), honor its ordering *and* its list
  indentation as nesting; otherwise sort by path. Files the `SUMMARY` forgot are appended
  rather than hidden. The set of `.md` files changes per deploy → `_gen` bump invalidates
  the cache.
- **Default doc:** for a markdown-only site, `/` renders `README.md` (or the first entry in
  `SUMMARY.md`) so the root is the docs home.
- **Page furniture:** headings get GitHub-style slugs (deduped per document) and a hover
  anchor; three or more of them earn an "on this page" column; the sidebar order also drives
  prev/next links under the article. A per-render `Marked` instance keeps that state from
  leaking between documents in a reused isolate.
- **Syntax highlighting** happens here, at render time, with `highlight.js/lib/core` and a
  curated set of ~27 languages (+68 KiB gzipped on the bundle, cached with the render, no
  CDN and no client script). Only *declared* languages are highlighted — auto-detection is a
  coin flip on short snippets — and the token colors are VS Code's own, Dark+ and Light+,
  so a block looks like the editor the reader already reads code in.
  highlight.js publishes `/// <reference lib="dom" />` in its types, which would drag the
  DOM lib over `@cloudflare/workers-types`; `src/shims/` + tsconfig `paths` keep it out.
- **Shell:** one amber accent over the landing's palette, prose in a ~72ch sans measure,
  chrome and code in mono. It follows `prefers-color-scheme` both ways, collapses the
  sidebar behind a CSS-only hamburger under 900px (a hidden checkbox holds the state, so it
  stays keyboard-reachable), and prints without the chrome. The only
  JavaScript is a copy button per code block and a scroll wrapper for wide tables — the page
  is complete without it.
- **Mixed sites just work:** `.html` is served as-is (§6); only `.md` gets the renderer. The
  share widget (§6.5), `noindex`, and the private gate all still apply to the rendered page
  (it's our HTML).
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
| Retention | 15 days since last change | infinite |
| Storage | 500 MB/account | 1 TB/account |

- **Anonymous (default).** The first `PUT` returns `ownerToken` once (only the secret's
  hash is stored). Every later call sends `Authorization: Bearer <ownerToken>`. Token loss
  = start over at new URLs (documented plainly).
- **Recovery email (optional, free).** `PATCH /account` attaches a recovery/abuse contact
  (unverified string in v1).
- **Paid (founder enables via admin).** Custom username (rename, one `R2.head` collision
  check) and/or custom domain (a `_domains` mapping + one-time dashboard zone/Custom Domain).
  A rename keeps the token's secret but changes its prefix: the owner now sends
  `{newname}.{secret}`. The customer's URLs change anyway, so they have to be told either way;
  an alias record for the old name was rejected as permanent machinery for a rare,
  operator-driven event. Rename copies every file through the Worker, which is slow for
  large accounts but needs no CPU and has no duration limit.

---

## 8. Admin

A thin, founder-operated surface — **not** a multi-user dashboard.

- Lives **in the same Worker**, served on **`admin.agenthost.page`** — an Access-protected
  hostname in our own zone (control-plane isolation, §6.6). Routing: `Host === admin.` +
  `APEX_HOST` → admin surface (Static Assets UI + JSON routes).
- **Auth = Cloudflare Access**, configured in the dashboard to allow only the operator's
  email (`ALLOWED_ADMIN_EMAIL`). The Worker verifies the signed Access JWT
  (`Cf-Access-Jwt-Assertion`) as defense-in-depth — no hand-rolled auth.
- **Operations** (all behind Access): list users/shares (`R2.list` on `_users/` and
  `_sites/{username}/`), set `plan`, rename a username, attach a custom domain (writes
  `_domains/{host}` + returns the dashboard checklist), and take down an abusive share. Each
  is a JSON edit in R2.
- Scales fine on `R2.list` at low volume; D1 can back the admin later if listing grows —
  additive, never touches the hot path.

---

## 9. Limits, quotas, retention & abuse (MVP)

### Limits & quotas (all tunable)

| Limit | Free | Paid |
|---|---|---|
| **Storage per account** | **500 MB** | **1 TB** |
| **Retention** | **15 days** since last change | **infinite** |

Plans differ only in what costs us money: storage and how long it's kept. Per-file and
per-share byte caps went away — with an account quota they only decided how the owner may
split their own storage. What remains is technical and the same for everyone:

- **1000 files per share.** Listing, docs navigation, the file index and orphan deletes
  scale with file count, which is CPU, not storage.
- **5 GB per file**, R2's single-PUT limit. Bodies through the Worker stop at ~100 MB (the
  zone), which only decides the door, not the allowance.
- **32 MB for a single file sent without `Content-Length`**, since it must be buffered to
  learn its size. curl always sends the length.

Caps are enforced **during the untar stream** (fail fast, §5 step 4) and at upload
reservation (§5.5). The per-user total is derived from the share records — `bytes` plus
pending reservations — with no mutable counter. A reservation that replaces a file counts
both until it completes: briefly conservative, never under.

### Retention sweep (cron)

A **Cron Trigger** on the same Worker runs nightly and deletes free-tier shares whose
`lastDeployAt` is older than 15 days — keeping R2 from bloating with abandoned shares.
Any write resets the clock. **Paid users (`plan === "paid"`) are skipped — infinite
retention.** Deleting a share = `R2.list` its prefix + delete all keys and its record.
Uploads reserved more than a day ago and never completed are deleted, with whatever
landed at their path, on every plan. A free account whose `createdAt` is older than 90 days
and has no share left after the pass loses its `_users/{username}` record too; its owner
token then gets a 403 and the agent starts a new account. The 90-day floor keeps a
brand-new account mid-first-publish safe. Users and shares are processed one cursor page
at a time without a global plan map or extra profile GETs. Deletions are idempotent and
logged with a bounded sample plus full counts. A failed cron retries from the beginning
on the next run; there is no durable checkpoint PUT.

### Abuse

Public-by-default publishing means day-one abuse risk. Controls, **no Durable Object**:

- **`X-Robots-Tag: noindex`** on all shares (§6) so spam/phishing can't ride the
  domain's search reputation.
- **Per-IP rate limits** on publishes, uploads and wrong access keys.
- **Size/count/quota caps** (above), enforced during untar.
- **Takedown** endpoint in the admin (§8).
- Turnstile deferred.

---

## 10. Monorepo layout

**Tooling:** **pnpm** (latest) workspaces · **Turborepo** (latest) for task orchestration ·
TypeScript · **Hono** in the Worker · **Astro** for the landing · **Svelte** for the admin ·
**rolldown** to minify the browser scripts the Worker inlines · Wrangler to deploy. The landing and admin are each built to static output and copied into
`public/`, which the Worker serves via Static Assets — so it's still **one `wrangler
deploy`**. Vitest for the Worker's tests; no linter or formatter — kept deliberately lean.

```
agenthost/
├─ package.json                 # workspace root; turbo pipeline (build → copy → deploy)
├─ pnpm-workspace.yaml
├─ turbo.json                   # build/deploy task graph across packages
├─ worker/                      # (2) THE BACKEND — the entire server (Hono on Workers)
│  ├─ src/index.ts              # fetch entry: routes by Host ; apex→landing/API ; admin ; *→serve ; custom-domain→serve
│  ├─ src/apex.ts               # the /shares REST API, /account, /llms.txt, /skill/
│  ├─ src/publish.ts            # PUT /shares/{id}: streaming files → bounded R2 puts → orphans → metadata commit
│  ├─ src/uploads.ts            # presigned uploads: quota reservation, exact-size signing, completion
│  ├─ src/serve.ts              # host→username, fresh metadata, gen-keyed Cache API, R2 get, file index, /_gen probe, widget + live-reload inject
│  ├─ src/client/*.ts           # browser scripts (live reload, copy link, docs shell), readable TS with DOM types
│  ├─ src/client/gen/           # ↑ minified into `export default "<js>"` modules by scripts/build-client.mjs (gitignored)
│  ├─ src/r2-signed.ts          # short-lived exact-size R2 PUT signing
│  ├─ src/skill.ts              # /skill/* — skills/agenthost with agenthost.page → APEX_HOST
│  ├─ src/admin.ts              # admin JSON routes (Hono sub-router, behind Cloudflare Access)
│  ├─ src/ids.ts                # username gen, reserved-word denylist, content-type guess
│  ├─ src/tar.ts                # streaming gzip+tar reader (no full buffering)
│  ├─ src/sniff.ts              # peek the first 1 KB → archive vs md vs html (Content-Type optional)
│  └─ wrangler.jsonc            # r2=SITES; assets binding + run_worker_first; routes; cron
├─ landing/                     # (1) LANDING PAGE for agents — Astro, static build → landing/dist
│  └─ src/pages/index.astro     #   the one-liner + curl contract
├─ skills/agenthost/           # (3) THE SHAREABLE SKILL (Agent Skill layout); also served at /skill/ for APEX_HOST
│  ├─ SKILL.md                  #   agent-readable; name + description frontmatter
│  └─ references/http-api.md    #   full HTTP API contract
├─ admin/                       # (4) ADMIN UI — Svelte (Vite SPA), static build → admin/dist
│  └─ src/App.svelte            #   founder dashboard; talks to worker /admin JSON routes
├─ public/                      # build output: landing/dist → / , admin/dist → /admin (ASSETS)
└─ README.md
```

One deployable. The build copies `landing/dist` and `admin/dist` into `public/`; the Worker
serves both via Static Assets and routes everything else by Host.

Dev runs local-first against Miniflare-simulated R2/Cache.
