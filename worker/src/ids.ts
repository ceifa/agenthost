// Username generation, reserved-word denylist, siteId sanitizing, content-type guess.

const ADJECTIVES = [
  "clever", "brave", "calm", "swift", "bright", "gentle", "lively", "merry",
  "noble", "proud", "quick", "quiet", "rapid", "shiny", "smooth", "sunny",
  "witty", "zesty", "amber", "cosmic", "crisp", "dewy", "eager", "fancy",
  "frosty", "golden", "happy", "jolly", "lucky", "mellow", "nimble", "plucky",
  "rustic", "silly", "spicy", "stellar", "tidy", "vivid", "warm", "wise",
];

const NOUNS = [
  "otter", "falcon", "maple", "comet", "willow", "pebble", "harbor", "meadow",
  "lantern", "cedar", "ember", "river", "summit", "thistle", "walrus", "badger",
  "heron", "lynx", "marten", "puffin", "raven", "robin", "sparrow", "tapir",
  "beacon", "canyon", "delta", "fjord", "glacier", "grove", "lagoon", "orchard",
  "prairie", "quartz", "reef", "tundra", "valley", "zephyr", "acorn", "bramble",
];

// Hosts/words we never want to hand out as a subdomain (collide with our own
// surfaces or are confusing/abusable on a public origin).
const RESERVED = new Set([
  "www", "admin", "api", "app", "apex", "root", "static", "assets", "cdn",
  "mail", "ftp", "ns", "ns1", "ns2", "dns", "host", "status", "support",
  "help", "docs", "blog", "dashboard", "console", "login", "auth", "account",
  "agenthost", "publish", "claim", "llms", "robots", "favicon", "sitemap",
  "test", "dev", "staging", "prod", "internal", "system", "security",
]);

const HEX = "0123456789abcdef";

function hex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return out;
}

function pick<T>(arr: readonly T[]): T {
  const idx = crypto.getRandomValues(new Uint32Array(1))[0]! % arr.length;
  return arr[idx]!;
}

// Memorable `adjectivenounhhh`; the hex suffix makes collisions negligible, so
// no uniqueness primitive is needed. No hyphens — the username is the part of
// the `{username}-{siteId}` subdomain before the first hyphen, so it must not
// contain one itself (see siteHost / the Host router in index.ts).
export function generateUsername(): string {
  const name = `${pick(ADJECTIVES)}${pick(NOUNS)}${hex(2)}`;
  if (isReserved(name)) return generateUsername();
  return name;
}

function isReserved(name: string): boolean {
  return RESERVED.has(name.toLowerCase());
}

// Hyphen-free so `{username}-{siteId}` is unambiguously splittable on the first
// hyphen. Capped so `{username}-{siteId}` fits a 63-octet DNS label (see
// sanitizeSiteId, which caps the other side).
const USERNAME_RE = /^[a-z0-9]{2,30}$/;

export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name) && !isReserved(name);
}

export function sanitizeSiteId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  // Cap at 32 so `{username}-{siteId}` (username ≤ 30) stays within a 63-octet
  // DNS label — the site now lives on that subdomain, not a path.
  if (!s || s === "." || s === ".." || s.length > 32) return null;
  return s;
}

const ALPHANUM = "abcdefghijkmnpqrstuvwxyz23456789"; // no ambiguous 0/o/1/l

export function generateAccessKey(len = 10): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += ALPHANUM[b % ALPHANUM.length]!;
  return out;
}

// 32 random bytes; only its sha256 is ever stored.
export function generateOwnerToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare to avoid leaking hash bytes via timing.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A site lives at its own subdomain: `{username}-{siteId}.{apex}`. The username
// is hyphen-free (see isValidUsername), so the host splits back on its first
// hyphen in the Host router.
export const siteHost = (username: string, siteId: string, apex: string) => `${username}-${siteId}.${apex}`;

// Canonical hosted-site URL (root of the site's subdomain) and the pre-authed
// share link with the access key embedded (?k=). `host` is the full site host.
// Every surface that prints a link (publish response, key rotation, Share
// widget) goes through these.
export const siteUrl = (host: string) => `https://${host}/`;
export const shareUrl = (host: string, key?: string | null) => `https://${host}/${key ? `?k=${key}` : ""}`;

// Caller identity for the rate limiters. Falls back to a shared sentinel when the
// header is absent (e.g. local dev) so the limiter key stays well-formed.
export const clientIp = (req: Request): string => req.headers.get("cf-connecting-ip") ?? "unknown";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  csv: "text/csv; charset=utf-8",
  zip: "application/zip",
  gz: "application/gzip",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
