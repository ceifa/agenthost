# agenthost HTTP API

Paths are relative to `https://agenthost.page/` (so `PUT https://agenthost.page/shares/report`). Every call except the first `PUT` sends `Authorization: Bearer <ownerToken>`. JSON bodies need no `Content-Type`.

## Shares

| Call | Does |
|---|---|
| `PUT /shares/{id}` | Publish a tar or one file. No `Authorization` creates an account. |
| `GET /shares` | List your shares (`?cursor=` pages past 1000). |
| `GET /shares/{id}` | One share, including its `url`. |
| `PATCH /shares/{id}` | `{"public": true}` drops the access gate; `false` restores it. |
| `POST /shares/{id}/key` | New access key. **Every link handed out before stops working**; the share turns private. |
| `DELETE /shares/{id}` | Delete the share and all its files. |
| `DELETE /shares/{id}/files/{path}` | Delete one file (percent-encode the path). |
| `POST /shares/{id}/uploads` | Reserve a large-file upload. |
| `PATCH /account` | `{"email": "you@example.com"}` sets a recovery/abuse contact. |

`id` is lowercased and reduced to `[a-z0-9._-]`, at most 32 characters.

### PUT /shares/{id}

| Query | Notes |
|---|---|
| `mode=merge` | Keep files the body doesn't carry. Default `replace` deletes them. |
| `file=<name>` | Publish the body as this one file; its extension sets the served type. |

A tar (gzipped or not) is a folder. Anything else is one document: Markdown is stored as `README.md`, HTML as `index.html`. A body that is neither text nor a tar needs `file=`. `.DS_Store`, `._*` and directory entries are skipped; `_gen` is reserved.

Response:

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

1. `POST /shares/{id}/uploads` with `{"path": "media/demo.mp4", "bytes": <exact size>, "contentType": "video/mp4"}` (`contentType` optional; guessed from the extension). Returns `uploadUrl`, `uploadHeaders`, `uploadExpiresIn` and the share's `url`.
2. `PUT` the file to `uploadUrl` within `uploadExpiresIn` seconds, sending every `uploadHeaders` entry as is. Anything else fails the signature.
No completion call. The next share access, owner read or write, or nightly sweep recognizes uploaded files automatically. Reservations count against quota immediately; replacing a file reserves only the extra space and never releases its old space before the upload arrives. Unused reservations expire after a day without deleting existing files. A `PUT` that replaces the share leaves uploads in flight alone.

The signed headers include `content-length`, `content-type` and `if-match` (replacement) or `if-none-match` (new file). Curl sets the length from the file; copy the other headers from `uploadHeaders`. R2 rejects a write if the target changed since reservation. A second reservation or Worker write to a path still awaiting its upload returns 409.

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
| 404 | No such share or file. |
| 409 | An upload is already pending at that path. |
| 413 | Out of account storage, over 1000 files, or a file over 5 GB. |
| 429 | Rate limited. Back off and retry. |

## Limits

| | Free | Paid |
|---|---|---|
| Storage, across all shares | 500 MB | unlimited |
| Retention | 15 days after the last change | forever |

Any plan: up to 1000 files per share and 5 GB per file. A single file sent without `Content-Length` is capped at 32 MB.

Paid plans, custom usernames and custom domains are enabled by the operator, not self-serve.
