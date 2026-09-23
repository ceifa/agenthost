# agenthost HTTP API

The publish contract. Base URL: `https://agenthost.page`. Plain `curl` throughout.

## Authentication

Two secrets, returned **once** by a site's first publish:

- **`ownerToken`** — account credential. Sent as `Authorization: Bearer <token>` on redeploys and owner endpoints. Only its SHA-256 is stored; lose it and you can only publish a new URL.
- **`accessKey`** — per-site password gating the private site. Embedded in `shareUrl` as `?k=<accessKey>`. Persists across redeploys.

Authenticated requests also need the account `username`, as `?username=<name>` or the `x-agenthost-user` header.

## POST /publish

Body is either a **gzipped tar** of a directory or a **single raw file**. No `Content-Type` header required.

| Param | Where | Notes |
|---|---|---|
| `id` | `?id=` or `x-agenthost-site` header | Subdomain label (`{username}-{id}.agenthost.page`). Generated if omitted. |
| `username` | `?username=` or `x-agenthost-user` header | Required **only** with `Authorization` (redeploys). |
| `file` | `?file=` | Single-file mode: names the stored file (sanitized). Optional. |
| `Authorization: Bearer <ownerToken>` | header | Omit for a first/anonymous publish (mints an account); include to redeploy. |

**Body:**

- A tar (gzipped or not) → the site directory.
- Anything else → one document: Markdown as `README.md`, HTML as `index.html`. Both serve at `/`.
- Any other file type → send `?file=<name>`; the extension sets the served `Content-Type`.

Single-file publish replaces the whole site with that one file. `id` defaults to `site` when omitted. A zip body is rejected with 400; send a gzipped tar. Curl examples are in [SKILL.md](../SKILL.md).

### Response (200)

```jsonc
{
  "url":        "https://cleverotter4f2-myblog.agenthost.page/", // bare URL (prompts for the key)
  "shareUrl":   "https://cleverotter4f2-myblog.agenthost.page/?k=<accessKey>", // give THIS to a human
  "username":   "cleverotter4f2",      // account name (auto-generated, no hyphens)
  "siteId":     "myblog",
  "generation": 2,                     // deploy counter (cache versioning)
  "fileCount":  12,
  "bytes":      48213,
  "accessKey":  "<shown once — first publish only>",
  "ownerToken": "<shown once — SAVE to redeploy>",
  "claimUrl":   "https://agenthost.page/claim?username=cleverotter4f2" // new accounts only
}
```

`accessKey` and `ownerToken` are returned **only on a site's first publish**; redeploys preserve them silently, and their `shareUrl` comes back bare (no `?k=`), identical to `url`. `ownerToken` and `claimUrl` appear only when the publish minted a new account, which every publish without `Authorization` does.

## Direct asset upload

Large binary assets use a three-request control flow; the payload itself goes directly to R2.

1. **Initiate** — `POST /asset?username=<username>` with owner auth and JSON `{ "name": "video.mp4", "bytes": 757603783, "contentType": "video/mp4" }`.
2. **Upload** — `PUT` the file to the returned `uploadUrl`, sending every returned `uploadHeaders` value exactly. The hostname is `*.r2.cloudflarestorage.com`; the Worker never receives the body.
3. **Complete** — `POST` the returned `completeUrl` with owner auth. Agenthost checks the R2 object size and marks the share page ready.

The initiate response carries `assetId`, `uploadUrl`, `uploadHeaders` (`content-length`, `content-type`, `content-disposition`), `uploadExpiresIn`, `completeUrl`, `url`, `shareUrl` and `accessKey`. The asset's `shareUrl` and `accessKey` exist **only** in that response; complete returns `{ ok, url, name, bytes }`. Opening the `shareUrl` shows the file name, type, size, and a **Download** button. The button targets a short-lived presigned R2 GET, so downloads also bypass the Worker. The object stores `Content-Disposition: attachment`, making browsers download instead of trying to render it.

The upload URL expires after 15 minutes and is restricted by its signature to one object, exact byte length, content type, and download filename. The download URL expires after five minutes and is generated whenever the share page opens.

| Asset limit | Free | Paid |
|---|---:|---:|
| Single asset | 100 MB | 5 GB |
| Total account storage | 500 MB, shared with sites | effectively unlimited |
| Retention | 15 days | infinite |

Pending uploads are deleted after one day. `DELETE /a/:username/:assetId?username=<username>` with owner auth removes a completed or pending asset.

## Owner endpoints

All require `Authorization: Bearer <ownerToken>` + `username`, and (except `/claim`) the site `id`.

**`POST /key/public`** — drop or restore the access gate.

```bash
curl -s -X POST -H 'Authorization: Bearer <ownerToken>' \
  'https://agenthost.page/key/public?username=<username>&id=myblog&public=true'
# → { "ok": true, "public": true }
```

**`POST /key/rotate`** — new `accessKey`, **invalidates all existing share links**, flips back to private.

```bash
curl -s -X POST -H 'Authorization: Bearer <ownerToken>' \
  'https://agenthost.page/key/rotate?username=<username>&id=myblog'
# → { "ok": true, "accessKey": "<new key>", "public": false, "shareUrl": "…/?k=<new key>" }
```

**`POST /claim`** — attach an unverified recovery/abuse-contact email.

```bash
curl -s -X POST -H 'Authorization: Bearer <ownerToken>' \
  'https://agenthost.page/claim?username=<username>&email=you@example.com'
# → { "ok": true, "username": "<username>", "email": "you@example.com" }
```

## Errors

JSON `{ "error": "<message>" }` with the status:

| Status | Cause |
|---|---|
| 400 | Empty body, nameless single file, archive with no files, unsafe path (`..`), or symlink/hardlink entry. |
| 401 | Missing `username` with a Bearer token. |
| 403 | Invalid username or owner token (indistinguishable — no enumeration). |
| 405 | Non-POST to `/publish`. |
| 413 | Over per-file cap, too many files, or over the size budget. |
| 429 | Rate limit exceeded (per IP). Back off and retry. |

## URL & path rules

- Served at `https://{username}-{id}.agenthost.page/…`; each site is its subdomain root.
- `username` is `[a-z0-9]`, 2–30 chars (**no hyphens** — it separates `{username}-{id}`).
- `siteId` is lowercased, sanitized to `[a-z0-9._-]`, ≤32 chars (so the label fits 63 chars).
- macOS cruft (`.DS_Store`, `._*`) and directory entries are skipped silently.
- Absolute (`/css/app.css`) and relative (`./css/app.css`) asset paths both work.
- All sites send `X-Robots-Tag: noindex, nofollow`.
- Open pages reload themselves when the site is republished (they poll `/_gen`, which is why `_gen` and `_meta` are reserved filenames). Add `<meta name="agenthost-live" content="off">` to an HTML page to opt out.

## Limits

| Limit | Free | Paid |
|---|---|---|
| Per file | 5 MB | 25 MB |
| Files per site | 50 | 1000 |
| Size per site | 250 MB | 1 GB |
| Total per account | 500 MB | effectively unlimited |
| Retention | 15 days since last publish | infinite |

Caps are enforced *during* the upload stream, so an over-limit publish fails fast. The paid tier (custom username / domain) is operator-enabled, not self-serve.
