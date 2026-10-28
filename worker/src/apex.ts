// Apex / control-plane app on agenthost.page: the /shares API, /account,
// /llms.txt and /skill/. Anything else falls through to Static Assets (the
// landing page).

import { Hono } from "hono";
import type { Env } from "./env";
import { handlePublish, safePath } from "./publish";
import { ownedShare, readJson, requireOwner, type AppContext } from "./auth";
import { deleteSite, listSitesPage, putMeta, putUser, siteFileKey, type SiteMeta } from "./storage";
import { generateAccessKey, metaUrl, siteHost } from "./ids";
import { llmsTxt } from "./llms";
import { skillFile } from "./skill";
import { completeUpload, createUpload } from "./uploads";

function describe(c: AppContext, username: string, id: string, meta: SiteMeta) {
  return {
    id,
    url: metaUrl(siteHost(username, id, c.env.APEX_HOST), meta),
    public: meta.public,
    bytes: meta.bytes,
    fileCount: meta.fileCount,
    createdAt: meta.createdAt,
    lastDeployAt: meta.lastDeployAt,
  };
}

const app = new Hono<{ Bindings: Env }>();

// Body through the Worker: a tar or one file, replacing the tree or merged into it.
app.put("/shares/:id", (c) => handlePublish(c.req.raw, c.env, c.req.param("id")));

// Straight to R2: one file per upload, always merged into the tree.
app.post("/shares/:id/uploads", createUpload);
app.post("/shares/:id/uploads/complete", completeUpload);

app.get("/shares", async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const page = await listSitesPage(c.env.SITES, owner.username, c.req.query("cursor"));
  return c.json({
    shares: page.items.map(({ siteId, meta }) => describe(c, owner.username, siteId, meta)),
    cursor: page.cursor ?? null,
  });
});

app.get("/shares/:id", async (c) => {
  const share = await ownedShare(c);
  if (share instanceof Response) return share;
  return c.json(describe(c, share.owner.username, share.id, share.meta));
});

app.patch("/shares/:id", async (c) => {
  const share = await ownedShare(c);
  if (share instanceof Response) return share;
  const value = (await readJson(c))?.public;
  if (typeof value !== "boolean") return c.json({ error: "JSON body {\"public\": true|false} required" }, 400);
  const meta = { ...share.meta, public: value };
  await putMeta(c.env.SITES, share.owner.username, share.id, meta);
  return c.json(describe(c, share.owner.username, share.id, meta));
});

// Rotating the key invalidates existing share links and makes the share private.
app.post("/shares/:id/key", async (c) => {
  const share = await ownedShare(c);
  if (share instanceof Response) return share;
  const { keyHash: _, ...rest } = share.meta;
  const meta = { ...rest, accessKey: generateAccessKey(), public: false };
  await putMeta(c.env.SITES, share.owner.username, share.id, meta);
  return c.json(describe(c, share.owner.username, share.id, meta));
});

app.delete("/shares/:id", async (c) => {
  const share = await ownedShare(c);
  if (share instanceof Response) return share;
  await deleteSite(c.env.SITES, share.owner.username, share.id);
  return c.json({ ok: true });
});

app.delete("/shares/:id/files/*", async (c) => {
  const share = await ownedShare(c);
  if (share instanceof Response) return share;
  const { owner, id, meta } = share;
  const raw = new URL(c.req.url).pathname;
  let path: string | null;
  try {
    path = safePath(decodeURIComponent(raw.slice(raw.indexOf("/files/") + "/files/".length)));
  } catch {
    path = null;
  }
  const object = path && !meta.pending?.[path] ? await c.env.SITES.head(siteFileKey(owner.username, id, path)) : null;
  if (!object) return c.json({ error: "file not found" }, 404);
  await c.env.SITES.delete(object.key);
  const next = {
    ...meta,
    generation: meta.generation + 1,
    lastDeployAt: Date.now(),
    bytes: Math.max(0, meta.bytes - object.size),
    fileCount: Math.max(0, meta.fileCount - 1),
  };
  await putMeta(c.env.SITES, owner.username, id, next);
  return c.json(describe(c, owner.username, id, next));
});

// Attach an unverified recovery/abuse email to the account.
app.patch("/account", async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const email = (await readJson(c))?.email;
  if (typeof email !== "string" || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "valid email required" }, 400);
  }
  await putUser(c.env.SITES, owner.username, { ...owner.user, email });
  return c.json({ username: owner.username, email });
});

app.get("/llms.txt", (c) =>
  c.body(llmsTxt(c.env.APEX_HOST), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }),
);

app.get("/skill/*", (c) => {
  const body = skillFile(c.req.path.slice("/skill/".length), c.env.APEX_HOST);
  if (body === null) return c.notFound();
  return c.body(body, 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=3600" });
});

// Unmatched paths → Static Assets (the landing page). Registered as the Hono
// notFound handler so route handlers can return real 404s without being
// swallowed by the fallthrough.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export const apexApp = app;
