// Apex / control-plane app on agenthost.page: /publish, owner endpoints, and
// /llms.txt. Anything else falls through to Static Assets (the landing page).

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./env";
import { handlePublish } from "./publish";
import { verifyOwner, type OwnerCtx } from "./auth";
import { getMeta, putMeta, putUser, type SiteMeta } from "./storage";
import { generateAccessKey, sha256Hex, sanitizeSiteId, siteHost, shareUrl } from "./ids";
import { llmsTxt } from "./llms";
import { completeAsset, createAsset, deleteAsset, serveAsset } from "./assets";

type Ctx = Context<{ Bindings: Env }>;

async function requireOwner(c: Ctx): Promise<OwnerCtx | Response> {
  const owner = await verifyOwner(c.req.raw, c.env);
  return owner.ok ? owner.ctx : c.json({ error: owner.error }, owner.status);
}

async function requireSite(c: Ctx, username: string): Promise<{ siteId: string; meta: SiteMeta } | Response> {
  const siteId = sanitizeSiteId(c.req.query("id"));
  if (!siteId) return c.json({ error: "id required" }, 400);
  const meta = await getMeta(c.env.SITES, username, siteId);
  if (!meta) return c.json({ error: "site not found" }, 404);
  return { siteId, meta };
}

// Tolerates an empty/non-JSON body.
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const app = new Hono<{ Bindings: Env }>();

app.post("/publish", (c) => handlePublish(c.req.raw, c.env));

// Large binary assets use a two-step control flow around a direct R2 PUT. The
// share page is served here, but neither uploads nor downloads cross the Worker.
app.post("/asset", createAsset);
app.post("/a/:username/:id/complete", completeAsset);
app.delete("/a/:username/:id", deleteAsset);
app.get("/a/:username/:id", serveAsset);

// Attach an unverified recovery/abuse email to the account.
app.post("/claim", async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const email = ((await readBody(c)).email as string | undefined) ?? c.req.query("email");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "valid email required" }, 400);
  }
  await putUser(c.env.SITES, owner.username, { ...owner.user, email });
  return c.json({ ok: true, username: owner.username, email });
});

// Rotating the key invalidates existing share links.
app.post("/key/rotate", async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const site = await requireSite(c, owner.username);
  if (site instanceof Response) return site;

  const accessKey = generateAccessKey();
  site.meta.keyHash = await sha256Hex(accessKey);
  site.meta.public = false;
  await putMeta(c.env.SITES, owner.username, site.siteId, site.meta);
  const url = shareUrl(siteHost(owner.username, site.siteId, c.env.APEX_HOST), accessKey);
  return c.json({ ok: true, accessKey, public: false, shareUrl: url });
});

app.post("/key/public", async (c) => {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const site = await requireSite(c, owner.username);
  if (site instanceof Response) return site;

  const makePublic = ((await readBody(c)).public as boolean | undefined) ?? c.req.query("public") !== "false";
  site.meta.public = makePublic;
  await putMeta(c.env.SITES, owner.username, site.siteId, site.meta);
  return c.json({ ok: true, public: makePublic });
});

app.get("/llms.txt", (c) =>
  c.body(llmsTxt(c.env.APEX_HOST), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }),
);

// Unmatched paths → Static Assets (the landing page). Registered as the Hono
// notFound handler so route handlers can return real 404s without being
// swallowed by the fallthrough.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export const apexApp = app;
