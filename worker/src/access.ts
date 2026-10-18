// The access-key gate shared by private sites and private assets.

import { AUTH_COOKIE_MAX_AGE } from "./config";
import { sha256Hex, timingSafeEqual } from "./ids";
import { NOINDEX, clientIp, getCookie } from "./http";

export type AccessGate =
  | { kind: "granted"; key: string }
  | { kind: "login"; response: Response } // 302 that sets the cookie
  | { kind: "denied"; status: 401 | 429; wrongKey: boolean };

export async function checkAccessKey(
  req: Request,
  url: URL,
  opts: {
    keyHash: string;
    cookieName: string;
    cookiePath: string;
    limiter: RateLimit;
    limiterScope: string; // what a wrong guess is throttled against, per IP
  },
): Promise<AccessGate> {
  const matches = async (key: string) => timingSafeEqual(await sha256Hex(key), opts.keyHash);

  const cookieKey = getCookie(req, opts.cookieName);
  if (cookieKey && await matches(cookieKey)) return { kind: "granted", key: cookieKey };

  const k = url.searchParams.get("k");
  if (!k) return { kind: "denied", status: 401, wrongKey: false };

  if (await matches(k)) {
    const clean = new URL(url);
    clean.searchParams.delete("k");
    const response = new Response(null, { status: 302, headers: { ...NOINDEX, location: clean.pathname + clean.search } });
    response.headers.append(
      "set-cookie",
      `${opts.cookieName}=${k}; Path=${opts.cookiePath}; Secure; HttpOnly; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`,
    );
    return { kind: "login", response };
  }

  // Wrong key: throttle guessing before re-prompting. (The keyspace already
  // makes brute force infeasible; this also caps the invocation cost.)
  const { success } = await opts.limiter.limit({ key: `${clientIp(req)}:${opts.limiterScope}` });
  return { kind: "denied", status: success ? 401 : 429, wrongKey: true };
}
