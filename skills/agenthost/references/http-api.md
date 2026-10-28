# agenthost HTTP API

Paths are relative to `https://agenthost.page/`. Every call sends `Authorization: Bearer <ownerToken>`, except a `PUT` meant to create a new account. JSON bodies need no `Content-Type`.

`{path}` is a file's path inside the share, percent-encoded (`a%20b.png`). No call takes a file name anywhere else.

## Shares

| Call | Does |
|---|---|
| `PUT /shares/{id}` | Publish a tar or one `.md`/`.html` as the whole share. |
| `PUT /shares/{id}/files/{path}` | Write the body as one file at `path`, keeping the other files. |
| `GET /shares` | List your shares (`?cursor=` pages past 1000). |
| `GET /shares/{id}` | One share, including its `url`. |
| `PATCH /shares/{id}` | `{"public": true}` drops the access gate; `false` restores it. |
| `POST /shares/{id}/key` | New access key. **Every link handed out before stops working**; the share turns private. |
| `DELETE /shares/{id}` | Delete the share and all its files. |
| `DELETE /shares/{id}/files/{path}` | Delete one file. |
| `POST /shares/{id}/uploads/prepare/{path}` | Reserve a large-file upload. |
| `POST /shares/{id}/uploads/complete/{path}` | Commit it. |
| `PATCH /account` | `{"email": "you@example.com"}` sets a recovery/abuse contact. |

`id` is lowercased and reduced to `[a-z0-9._-]`, at most 32 characters.

### Publishing

`PUT /shares/{id}` replaces every file; `?mode=merge` keeps the ones the body doesn't carry. A tar (gzipped or not) is a folder. Anything else must be one document: Markdown is stored as `README.md`, HTML as `index.html`. `.DS_Store`, `._*` and directory entries are skipped.

`PUT /shares/{id}/files/{path}` stores the body as is, a tar included; the extension sets the served type. `_gen` is reserved. Every file is served with the type of its extension.

Both answer:

```jsonc
{
  "url": "https://cleverotter4f2-myblog.agenthost.page/?k=<key>", // give THIS to a human
  "id": "myblog",
  "username": "cleverotter4f2",
  "fileCount": 12,
  "bytes": 48213,
  "ownerToken": "<only when this call created the account>"
}
```

`GET`, `PATCH` and `POST …/key` answer with `{ id, url, public, bytes, fileCount, createdAt, lastDeployAt }`. A public share's `url` carries no key.

### Uploads

1. `POST /shares/{id}/uploads/prepare/media/demo.mp4` with `{"bytes": <exact size>}`. Returns `uploadUrl`, `uploadHeaders`, `uploadExpiresIn` and the share's `url`.
2. `PUT` the file to `uploadUrl` within `uploadExpiresIn` seconds. The only signed header is `content-length`, which `curl -T` sets itself; a different size fails the signature.
3. `POST /shares/{id}/uploads/complete/media/demo.mp4`, no body. Returns `{ url, id, path, bytes, fileCount }`.

The reserved bytes count against the account until completed. A size mismatch deletes the upload; one never completed is discarded after a day. A `PUT` that replaces the share leaves uploads in flight alone.

## Reading a share

- A share lives at `https://{username}-{id}.agenthost.page/`, the root of its own subdomain: `/css/app.css` and `./css/app.css` both resolve.
- `/` serves `index.html`, else the Markdown home, else a preview of the single file or a list of all of them.
- `?download` on any file saves it with its name. `?raw` on a `.md` shows the source.
- Open pages poll for changes and reload. Opt out with `<meta name="agenthost-live" content="off">`.
- Every response is `noindex`.

## Errors

JSON `{ "error": "<message>" }`:

| Status | Cause |
|---|---|
| 400 | Empty or unrecognized body, unsafe path, link in the tar, bad `id`, `mode` or JSON. |
| 401 | Missing or malformed `Authorization`. |
| 403 | Wrong owner token. |
| 404 | No such share, file or pending upload. |
| 409 | Completing an upload whose file never arrived. |
| 413 | Out of account storage, over 1000 files, or a file over 5 GB. |
| 429 | Rate limited. Back off and retry. |
| 503 | This server has large-file uploads switched off. |

## Limits

| | Free | Paid |
|---|---|---|
| Storage, across all shares | 500 MB | 1 TB |
| Retention | 15 days after the last change | 1 year after the last change |

Any plan: up to 1000 files per share and 5 GB per file. A single file sent without `Content-Length` is capped at 32 MB.

Paid plans, custom usernames and custom domains are enabled by the operator, not self-serve.
