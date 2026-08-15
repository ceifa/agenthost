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
