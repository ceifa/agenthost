// Founder-only admin, served on admin.{APEX_HOST} behind Cloudflare Access.
// verifyAdmin() validates the signed Access JWT on every route as
// defense-in-depth, so the routes are safe even if a request somehow reaches the
// Worker without passing through Access.

import { Hono } from "hono";
import type { Env } from "./env";
import { verifyAdmin, type AppContext } from "./auth";
import {
  listAll,
  listUsersPage,
  listSitesPage,
  deleteKeys,
  getUser,
  putUser,
  getMeta,
  putMeta,
  userSitesPrefix,
  userKey,
  mapBounded,
  owners,
} from "./storage";
import { isValidUsername } from "./ids";

const api = new Hono<{ Bindings: Env }>();

api.use("*", async (c, next) => {
  if (!(await verifyAdmin(c.req.raw, c.env))) return c.json({ error: "forbidden" }, 403);
  await next();
});

api.get("/users", async (c) => {
  const page = await listUsersPage(c.env.SITES, c.req.query("cursor"));
  const usernames = page.items.map((i) => i.username);
  const shareOwners = await owners(c.env.SITES, usernames);
  const users = page.items.map(({ username, user }) => ({
    username,
    plan: user.plan,
    email: user.email,
    createdAt: user.createdAt,
    hasShares: shareOwners.has(username),
  }));
  return c.json({ users, cursor: page.cursor ?? null });
});

api.get("/sites", async (c) => {
  const username = c.req.query("username");
  if (!username) return c.json({ error: "username required" }, 400);
  const user = await getUser(c.env.SITES, username);
  if (!user) return c.json({ error: "user not found" }, 404);
  const page = await listSitesPage(c.env.SITES, username, c.req.query("cursor"));
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

// The JSON body, if it's an object whose `fields` are all non-empty strings.
async function readFields<K extends string>(c: AppContext, ...fields: K[]): Promise<(Record<K, string> & Record<string, unknown>) | null> {
  const body = await c.req.json<Record<string, unknown> | null>().catch(() => null);
  if (!body || typeof body !== "object" || fields.some(f => typeof body[f] !== "string" || body[f] === "")) return null;
  return body as Record<K, string> & Record<string, unknown>;
}

api.post("/plan", async (c) => {
  const body = await readFields(c, "username", "plan");
  if (!body) return c.json({ error: "username and plan required" }, 400);
  const { username, plan } = body;
  const user = await getUser(c.env.SITES, username);
  if (!user) return c.json({ error: "unknown username" }, 404);
  if (plan !== "free" && plan !== "paid") return c.json({ error: "bad plan" }, 400);
  await putUser(c.env.SITES, username, { ...user, plan });
  return c.json({ ok: true, username, plan });
});

api.post("/rename", async (c) => {
  const body = await readFields(c, "from", "to");
  if (!body) return c.json({ error: "from and to required" }, 400);
  const { from, to } = body;
  if (!isValidUsername(to)) return c.json({ error: "invalid target username" }, 400);
  if (await c.env.SITES.head(userKey(to))) return c.json({ error: "username taken" }, 409);
  const user = await getUser(c.env.SITES, from);
  if (!user) return c.json({ error: "unknown username" }, 404);

  await putUser(c.env.SITES, to, user);
  const objs = await listAll(c.env.SITES, userSitesPrefix(from));
  const flat = [...await listAll(c.env.SITES, `_sites/${from}/`), ...await listAll(c.env.SITES, `_visits/${from}/`)];
  // Copy in bounded batches — sequential round trips would crawl on big accounts.
  await mapBounded([...objs, ...flat], async (o) => {
    const body = await c.env.SITES.get(o.key);
    if (!body) return;
    const [root] = o.key.split("/", 1);
    const newKey = `${root}/${to}/${o.key.slice(`${root}/${from}/`.length)}`;
    await c.env.SITES.put(newKey, body.body, { httpMetadata: body.httpMetadata, customMetadata: body.customMetadata });
  });
  await deleteKeys(c.env.SITES, [...objs, ...flat].map((o) => o.key));
  await c.env.SITES.delete(userKey(from));
  return c.json({ ok: true, from, to });
});

api.post("/takedown", async (c) => {
  const body = await readFields(c, "username", "siteId");
  if (!body) return c.json({ error: "username and siteId required" }, 400);
  const { username, siteId, tombstone = true } = body;
  if (typeof tombstone !== "boolean") return c.json({ error: "tombstone must be a boolean" }, 400);
  const meta = await getMeta(c.env.SITES, username, siteId);
  if (!meta) return c.json({ error: "site not found" }, 404);
  meta.tombstone = tombstone;
  await putMeta(c.env.SITES, username, siteId, meta);
  return c.json({ ok: true, username, siteId, tombstone });
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
