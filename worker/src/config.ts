// Tunable limits & quotas. All sizes in bytes.

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

// Plans differ only in storage and retention; how it's split across shares
// and files is the account's business.
export interface PlanLimits {
  perUser: number;
  retentionDays: number | null; // days since last deploy before the sweep deletes; null = infinite
}

export const LIMITS: Record<"free" | "paid", PlanLimits> = {
  free: { perUser: 500 * MB, retentionDays: 15 },
  paid: { perUser: Number.MAX_SAFE_INTEGER, retentionDays: null },
};

// Same for every plan. Listing, docs navigation, the file index and orphan
// deletes all scale with the file count; R2 takes at most 5 GB in one PUT.
export const MAX_FILES = 1000;
export const MAX_FILE_BYTES = 5 * GB;
// A single-file body without Content-Length has to be buffered to learn its size.
export const MAX_BUFFERED_BYTES = 32 * MB;

// Expired reservations release quota without deleting files already in R2.
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;

// The Cache API refuses objects past this size; larger files stream from R2.
export const CACHE_MAX_BYTES = 512 * MB;

// In-flight R2 puts during untar. Entries stream into R2 one at a time, so this
// only overlaps a put's commit with reading the next entry; no put holds a
// buffered file.
export const PUT_CONCURRENCY = 3;
export const AUTH_COOKIE_PREFIX = "as_auth_";
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // ~1 year, seconds

// Rendered markdown is cached per deploy generation, which a *site* bumps when it
// publishes — a Worker deploy doesn't. Without this, shipping a change to the
// renderer or the shell would only reach sites that happen to republish. Bump it
// whenever the markdown output changes.
export const RENDER_VERSION = 5;

// Bound untrusted Markdown work per cache miss, independent of upload limits.
export const RENDER_LIMITS = {
  documentChars: 256 * 1024,
  highlightBlockChars: 2048,
  highlightTotalChars: 4096,
};

// Live reload. One visible tab per origin polls /_gen and shares the site's version
// changes. Each poll is a Worker invocation, so the client polls rarely and only
// while visible; the Worker answers from a short edge micro-cache so R2 sees one
// read per site, per colo, per TTL no matter how many readers there are. The
// TTL adds to the poll interval as worst-case detection delay.
export const LIVE = {
  genCacheTtlSeconds: 15,
  // Client cadence (ms). Fast for recently published content (an agent iterating
  // on a page), base otherwise, slow once the reader is idle.
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
