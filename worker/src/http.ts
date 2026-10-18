export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Hosted content is never indexed — only the apex landing is.
export const NOINDEX = { "x-robots-tag": "noindex, nofollow" } as const;

// Caller identity for the rate limiters. Falls back to a shared sentinel when the
// header is absent (e.g. local dev) so the limiter key stays well-formed.
export const clientIp = (req: Request): string => req.headers.get("cf-connecting-ip") ?? "unknown";
