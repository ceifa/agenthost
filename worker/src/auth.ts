// Auth helpers: ownerToken verification (data-plane), the access-key gate on
// private shares, and Access email verification (admin).

import type { Context } from "hono";
import type { Env } from "./env";
import { AUTH_COOKIE_MAX_AGE } from "./config";
import { getMeta, getUser, type SiteMeta, type UserRecord } from "./storage";
import { sha256Hex, timingSafeEqual, clientIp, sanitizeSiteId } from "./ids";
import { interstitialHtml } from "./templates";

export type AppContext = Context<{ Bindings: Env }>;

export interface OwnerCtx {
  username: string;
  user: UserRecord;
}

export type OwnerResult =
  | { ok: true; ctx: OwnerCtx }
  | { ok: false; status: 401 | 403; error: string };

// The owner token is `{username}.{secret}`; usernames never contain a dot.
export async function verifyOwner(req: Request, env: Env): Promise<OwnerResult> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const dot = token.indexOf(".");
  if (dot <= 0) {
    return { ok: false, status: 401, error: "Authorization: Bearer <ownerToken> required" };
  }
  const username = token.slice(0, dot);
  const user = await getUser(env.SITES, username);
  // One indistinguishable failure for both unknown-username and wrong-token, and
  // always run the compare (against a dummy of equal length when the user is
  // missing) so neither the message nor the timing reveals whether the username
  // exists.
  const expected = user?.tokenHash ?? "0".repeat(64); // sha256 hex is 64 chars
  const match = timingSafeEqual(await sha256Hex(token.slice(dot + 1)), expected);
  if (!user || !match) {
    return { ok: false, status: 403, error: "invalid owner token" };
  }
  return { ok: true, ctx: { username, user } };
}

export async function requireOwner(c: AppContext): Promise<OwnerCtx | Response> {
  const owner = await verifyOwner(c.req.raw, c.env);
  return owner.ok ? owner.ctx : c.json({ error: owner.error }, owner.status);
}

// The owner and the share named by the route's :id, or the response to send instead.
export async function ownedShare(c: AppContext): Promise<{ owner: OwnerCtx; id: string; meta: SiteMeta } | Response> {
  const owner = await requireOwner(c);
  if (owner instanceof Response) return owner;
  const id = sanitizeSiteId(c.req.param("id"));
  const meta = id ? await getMeta(c.env.SITES, owner.username, id) : null;
  if (!id || !meta) return c.json({ error: "share not found" }, 404);
  return { owner, id, meta };
}

// The request's JSON body if it is an object, else null.
export async function readJson(c: AppContext): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Returns the reader's access key, or the response to send instead: a matching
// ?k logs the visitor in via cookie, then redirects to drop the key from the
// URL; anything else gets the password prompt.
export async function checkAccessKey(
  req: Request,
  env: Env,
  gate: { accessKey?: string; keyHash?: string; label: string; cookieName: string; limiterKey: string },
): Promise<string | Response> {
  const matches = async (key: string) => gate.accessKey !== undefined
    ? timingSafeEqual(key, gate.accessKey)
    : timingSafeEqual(await sha256Hex(key), gate.keyHash ?? "");
  const cookie = getCookie(req, gate.cookieName);
  if (cookie && await matches(cookie)) return cookie;

  const url = new URL(req.url);
  const k = url.searchParams.get("k");
  const noindex = { "x-robots-tag": "noindex, nofollow" };
  if (k && await matches(k)) {
    url.searchParams.delete("k");
    const res = new Response(null, { status: 302, headers: { ...noindex, location: url.pathname + url.search } });
    res.headers.append("set-cookie", `${gate.cookieName}=${k}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`);
    return res;
  }
  // Wrong key: throttle guessing before re-prompting. (The keyspace already
  // makes brute force infeasible; this also caps the invocation cost.)
  const limited = !!k && !(await env.ACCESS_LIMITER.limit({ key: `${clientIp(req)}:${gate.limiterKey}` })).success;
  return new Response(interstitialHtml({ siteId: gate.label, apexHost: env.APEX_HOST, wrong: !!k }), {
    status: limited ? 429 : 401,
    headers: { ...noindex, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Admin auth: verify the *signed* Access JWT (Cf-Access-Jwt-Assertion), not the
// plaintext Cf-Access-Authenticated-User-Email header. The email header is only
// trustworthy if Access is guaranteed to sit in front of every request and strip
// client-supplied copies; the JWT is cryptographically signed by our Access team,
// so it can't be forged even if a request reaches the Worker without going
// through Access. We then re-check the email claim against the founder allow-list
// as defense-in-depth.
export async function verifyAdmin(req: Request, env: Env): Promise<boolean> {
  // Local dev has no Cloudflare Access in front of the admin host. DEV_MODE is
  // only ever set in .dev.vars (never in production), so this bypass is safe.
  if (env.DEV_MODE === "1") return true;

  const token = req.headers.get("cf-access-jwt-assertion");
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const allowed = env.ALLOWED_ADMIN_EMAIL;
  // Missing config or token → fail closed. Never fall back to the email header.
  if (!token || !teamDomain || !aud || !allowed) return false;

  try {
    const payload = await verifyAccessJwt(token, teamDomain, aud);
    return !!payload.email && payload.email.toLowerCase() === allowed.toLowerCase();
  } catch {
    return false;
  }
}

interface AccessJwtPayload {
  iss?: string;
  aud?: string | string[];
  email?: string;
  exp?: number;
  nbf?: number;
}

// Cache the imported verification keys per kid. Access rotates signing keys, so
// on an unknown kid we force one refresh before giving up.
const jwkByKid = new Map<string, CryptoKey>();
let certsExpireAt = 0;
const CERTS_TTL_MS = 3_600_000; // 1h

async function loadCerts(teamDomain: string): Promise<void> {
  if (Date.now() < certsExpireAt && jwkByKid.size) return;
  const res = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs fetch failed: ${res.status}`);
  const { keys } = await res.json<{ keys: (JsonWebKey & { kid: string })[] }>();
  jwkByKid.clear();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    jwkByKid.set(jwk.kid, key);
  }
  certsExpireAt = Date.now() + CERTS_TTL_MS;
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<AccessJwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [h, p, s] = parts as [string, string, string];

  const header = JSON.parse(b64urlToString(h)) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  if (!header.kid) throw new Error("missing kid");

  await loadCerts(teamDomain);
  let key = jwkByKid.get(header.kid);
  if (!key) {
    certsExpireAt = 0; // force a refresh in case Access rotated keys
    await loadCerts(teamDomain);
    key = jwkByKid.get(header.kid);
  }
  if (!key) throw new Error("unknown kid");

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");

  const payload = JSON.parse(b64urlToString(p)) as AccessJwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf > now) throw new Error("not yet valid");
  if (payload.iss !== `https://${teamDomain}.cloudflareaccess.com`) throw new Error("bad iss");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error("bad aud");
  return payload;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}
