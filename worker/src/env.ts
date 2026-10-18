// Worker bindings (mirrors worker/wrangler.jsonc). Hand-maintained so the build
// doesn't depend on `wrangler types` codegen.

export interface Env {
  SITES: R2Bucket;
  ASSETS: Fetcher;
  APEX_HOST: string; // control-plane host (landing + /publish)
  // Object-scoped S3 credentials used only to generate short-lived presigned
  // URLs. Asset payloads travel directly between the client and R2.
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // Admin auth (Cloudflare Access). The admin is served on admin.{APEX_HOST}, an
  // Access-protected hostname in our own zone. verifyAdmin validates the signed
  // Access JWT against ACCESS_TEAM_DOMAIN's certs, checks the app's ACCESS_AUD
  // tag, then re-checks the email claim against ALLOWED_ADMIN_EMAIL.
  ALLOWED_ADMIN_EMAIL?: string;
  ACCESS_TEAM_DOMAIN?: string; // your Access team, e.g. "acme" → https://acme.cloudflareaccess.com
  ACCESS_AUD?: string; // Access Application audience (AUD) tag from the dashboard
  DEV_MODE?: string; // "1" honors the ?__host= routing override — local dev only
  // Custom domains need no bindings: the admin records a `_domains` mapping and
  // completes routing + TLS once per domain in the dashboard (see domains.ts).
  // Per-IP rate limiters (Workers native binding; namespaces in wrangler.jsonc).
  // PUBLISH_LIMITER guards /publish (anonymous account minting is the main abuse
  // lever); ACCESS_LIMITER throttles wrong-key attempts on private sites.
  PUBLISH_LIMITER: RateLimit;
  ACCESS_LIMITER: RateLimit;
}
