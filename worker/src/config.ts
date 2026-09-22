// Tunable limits & quotas. All sizes in bytes.

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export interface PlanLimits {
  perFile: number;
  filesPerSite: number;
  perSite: number;
  perUser: number;
  retentionDays: number | null; // days since last deploy before the sweep deletes; null = infinite
}

export const LIMITS: Record<"free" | "paid", PlanLimits> = {
  free: {
    perFile: 5 * MB,
    filesPerSite: 50,
    perSite: 250 * MB,
    perUser: 500 * MB,
    retentionDays: 15,
  },
  paid: {
    perFile: 25 * MB,
    filesPerSite: 1000,
    perSite: 1024 * MB,
    perUser: Number.MAX_SAFE_INTEGER,
    retentionDays: null,
  },
};

// Direct assets have a separate budget from static sites. Free accounts get a
// useful but abuse-resistant allowance; paid accounts can use R2's maximum
// single-PUT size. The signed Content-Length prevents uploading past perAsset.
export const ASSET_LIMITS: Record<"free" | "paid", { perAsset: number; perUser: number }> = {
  free: { perAsset: 100 * MB, perUser: 500 * MB },
  paid: { perAsset: 5 * GB, perUser: Number.MAX_SAFE_INTEGER },
};

// In-flight R2 puts during untar. Each holds its entry buffer alive, so
// PUT_CONCURRENCY * perFile (25 MB) must stay well under the Worker's ~128 MB
// isolate memory limit — 3 * 25 MB = 75 MB leaves room for the entry being read
// plus gunzip/tar buffers. Raising perFile or this value together can OOM.
export const PUT_CONCURRENCY = 3;
export const DEFAULT_SITE_ID = "site";
export const AUTH_COOKIE_PREFIX = "as_auth_";
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // ~1 year, seconds

// Rendered markdown is cached per deploy generation, which a *site* bumps when it
// publishes — a Worker deploy doesn't. Without this, shipping a change to the
// renderer or the shell would only reach sites that happen to republish. Bump it
// whenever the markdown output changes.
export const RENDER_VERSION = 3;

// Live reload. Every open page polls /_gen and reloads when the site's version
// changes. Each poll is a Worker invocation, so the client polls rarely and only
// while visible; the Worker answers from a short edge micro-cache so R2 sees one
// read per site, per colo, per TTL no matter how many readers there are. The
// TTL adds to the poll interval as worst-case detection delay.
export const LIVE = {
  genCacheTtlSeconds: 15,
  // Client cadence (ms). Fast right after load or after a detected change (an
  // agent iterating on a page), base otherwise, slow once the reader is idle.
  fastMs: 15_000,
  fastForMs: 5 * 60_000,
  baseMs: 60_000,
  idleMs: 5 * 60_000,
  idleAfterMs: 30 * 60_000,
  // Errors (network, 5xx, 429) back off exponentially up to this, never reload.
  maxBackoffMs: 10 * 60_000,
  // Re-check this often while a pending reload waits for the reader to finish a
  // text selection or leave a focused input.
  busyRetryMs: 5_000,
};
