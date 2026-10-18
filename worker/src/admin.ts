// Founder-only admin, served on admin.{APEX_HOST} behind Cloudflare Access.
// verifyAdmin() validates the signed Access JWT on every route as
// defense-in-depth, so the routes are safe even if a request somehow reaches the
// Worker without passing through Access.

import { Hono } from "hono";
import type { Env } from "./env";
import { verifyAdmin } from "./auth";
import {
  listAll,
  listUsersPage,
  listSitesPage,
  listAssetsPage,
  deleteKeys,
  getUser,
  putUser,
  getMeta,
  putMeta,
  putDomain,
  userSitesPrefix,
  userMetaPrefix,
  userKey,
  assetMetaKey,
  getAssetMeta,
  listAssetMetas,
  putAssetMeta,
  mapBounded,
  InvalidCursorError,
} from "./storage";
import { isValidUsername } from "./ids";
import { customDomainSetup } from "./domains";

const api = new Hono<{ Bindings: Env }>();

api.use("*", async (c, next) => {
  if (!(await verifyAdmin(c.req.raw, c.env))) return c.json({ error: "forbidden" }, 403);
  await next();
});

api.get("/users", async (c) => {
  const page = await listUsersPage(c.env.SITES, c.req.query("cursor"));
  const users = page.items.map(({ username, user }) => ({
    username,
    plan: user.plan,
    email: user.email,
    customDomain: user.customDomain,
    createdAt: user.createdAt,
  }));
  return c.json({ users, cursor: page.cursor ?? null });
});

api.get("/sites", async (c) => {
  const username = c.req.query("username");
  if (!username) return c.json({ error: "username required" }, 400);
  const user = await getUser(c.env.SITES, username);
  if (!user) return c.json({ error: "user not found" }, 404);
  let page;
  try {
    page = await listSitesPage(c.env.SITES, username, user, c.req.query("cursor"));
  } catch (error) {
    if (error instanceof InvalidCursorError) return c.json({ error: error.message }, 400);
    throw error;
  }
  const sites = page.items.map(({ siteId, meta: m }) => ({
    siteId,
    bytes: m.bytes,
    fileCount: m.fileCount,
    createdAt: m.createdAt,
    lastDeployAt: m.lastDeployAt,
    public: m.public,
    tombstone: m.tombstone ?? false,
  }));
  return c.json({ username, sites, cursor: page.cursor ?? null });
});

api.get("/assets", async (c) => {
  const username = c.req.query("username");
  if (!username) return c.json({ error: "username required" }, 400);
  const page = await listAssetsPage(c.env.SITES, username, c.req.query("cursor"));
  const assets = page.items.map((m) => ({
    id: m.id,
    name: m.name,
    bytes: m.bytes,
    contentType: m.contentType,
    status: m.status,
    createdAt: m.createdAt,
  }));
  return c.json({ username, assets, cursor: page.cursor ?? null });
});

api.delete("/asset", async (c) => {
  const username = c.req.query("username");
  const id = c.req.query("id");
  if (!username || !id) return c.json({ error: "username and id required" }, 400);
  const meta = await getAssetMeta(c.env.SITES, username, id);
  if (!meta) return c.json({ error: "asset not found" }, 404);
  await Promise.all([c.env.SITES.delete(meta.objectKey), c.env.SITES.delete(assetMetaKey(username, id))]);
  return c.json({ ok: true });
});

api.post("/plan", async (c) => {
  const { username, plan } = await c.req.json<{ username: string; plan: "free" | "paid" }>();
  const user = await getUser(c.env.SITES, username);
  if (!user) return c.json({ error: "unknown username" }, 404);
  if (plan !== "free" && plan !== "paid") return c.json({ error: "bad plan" }, 400);
  await putUser(c.env.SITES, username, { ...user, plan });
  return c.json({ ok: true, username, plan });
});

api.post("/rename", async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  if (!isValidUsername(to)) return c.json({ error: "invalid target username" }, 400);
  if (await c.env.SITES.head(userKey(to))) return c.json({ error: "username taken" }, 409);
  const user = await getUser(c.env.SITES, from);
  if (!user) return c.json({ error: "unknown username" }, 404);

  await putUser(c.env.SITES, to, user);
  // Site files and their metadata records, each moved to the same place under `to`.
  const moves: [string, string][] = [];
  for (const [fromPrefix, toPrefix] of [
    [userSitesPrefix(from), userSitesPrefix(to)],
    [userMetaPrefix(from), userMetaPrefix(to)],
  ] as const) {
    for (const o of await listAll(c.env.SITES, fromPrefix)) moves.push([o.key, toPrefix + o.key.slice(fromPrefix.length)]);
  }
  // Copy in bounded batches — sequential round trips would crawl on big accounts.
  await mapBounded(moves, async ([fromKey, toKey]) => {
    const body = await c.env.SITES.get(fromKey);
    if (!body) return;
    await c.env.SITES.put(toKey, body.body, { httpMetadata: body.httpMetadata, customMetadata: body.customMetadata });
  });
  await deleteKeys(c.env.SITES, moves.map(([fromKey]) => fromKey));

  // Asset payloads stay at their immutable R2 keys; only their tiny metadata
  // moves to the renamed account, avoiding a multi-gigabyte copy through Worker.
  const assets = await listAssetMetas(c.env.SITES, from);
  await mapBounded(assets, async (asset) => {
    await putAssetMeta(c.env.SITES, to, asset.id, { ...asset, username: to });
    await c.env.SITES.delete(assetMetaKey(from, asset.id));
  });
  await c.env.SITES.delete(userKey(from));
  return c.json({ ok: true, from, to });
});

api.post("/takedown", async (c) => {
  const { username, siteId, tombstone = true } = await c.req.json<{
    username: string;
    siteId: string;
    tombstone?: boolean;
  }>();
  const meta = await getMeta(c.env.SITES, username, siteId);
  if (!meta) return c.json({ error: "site not found" }, 404);
  meta.tombstone = tombstone;
  await putMeta(c.env.SITES, username, siteId, meta);
  return c.json({ ok: true, username, siteId, tombstone });
});

api.post("/domain", async (c) => {
  const { host, username, siteId } = await c.req.json<{ host: string; username: string; siteId: string }>();
  if (!host || !username || !siteId) return c.json({ error: "host, username, siteId required" }, 400);
  const user = await getUser(c.env.SITES, username);
  if (!user) return c.json({ error: "unknown username" }, 404);

  await putDomain(c.env.SITES, host, { username, siteId });
  await putUser(c.env.SITES, username, { ...user, customDomain: host });
  const provision = customDomainSetup(host);
  return c.json({ ok: true, host, username, siteId, provision });
});

const app = new Hono<{ Bindings: Env }>();
app.route("/admin/api", api);

// Everything else is the admin SPA, served from Static Assets under /admin/.
app.all("*", async (c) => {
  if (!(await verifyAdmin(c.req.raw, c.env))) return c.text("forbidden", 403);
  if (c.req.path.startsWith("/admin/api")) return c.notFound(); // unmatched API route, not an asset
  const fetchAsset = (pathname: string) => {
    const u = new URL(c.req.url);
    u.pathname = pathname;
    return c.env.ASSETS.fetch(new Request(u.toString(), { method: "GET" }));
  };
  const res = await fetchAsset(c.req.path === "/" ? "/admin/index.html" : `/admin${c.req.path}`);
  return res.status === 404 ? fetchAsset("/admin/index.html") : res; // SPA fallback
});

export const handleAdmin = async (req: Request, env: Env): Promise<Response> => app.fetch(req, env);
