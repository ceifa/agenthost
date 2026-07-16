// Auth helpers: ownerToken verification (data-plane) and Access email
// verification (admin).

import type { Env } from "./env";
import { getUser, type UserRecord } from "./storage";
import { sha256Hex, timingSafeEqual } from "./ids";

export interface OwnerCtx {
  username: string;
  user: UserRecord;
}

export type OwnerResult =
  | { ok: true; ctx: OwnerCtx }
  | { ok: false; status: 401 | 403; error: string };

// Single owner-credential contract: Bearer token + username claimed via
// ?username= or the x-agenthost-user header.
export async function verifyOwner(req: Request, env: Env): Promise<OwnerResult> {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "").trim();
  const username =
    new URL(req.url).searchParams.get("username") ?? req.headers.get("x-agenthost-user");
  if (!token || !username) {
    return { ok: false, status: 401, error: "Bearer token requires ?username=<your-username>" };
  }
  const user = await getUser(env.SITES, username);
  // One indistinguishable failure for both unknown-username and wrong-token, and
  // always run the compare (against a dummy of equal length when the user is
  // missing) so neither the message nor the timing reveals whether the username
  // exists.
  const expected = user?.tokenHash ?? "0".repeat(64); // sha256 hex is 64 chars
  const match = timingSafeEqual(await sha256Hex(token), expected);
  if (!user || !match) {
    return { ok: false, status: 403, error: "invalid username or owner token" };
  }
  return { ok: true, ctx: { username, user } };
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
