import { describe, expect, it } from "vitest";
import { cacheKeyPath, versionTag, genResponse } from "./serve";
import { liveScript } from "./templates";
import LIVE_JS from "./client/gen/live";
import { RENDER_VERSION, LIVE } from "./config";

describe("edge cache key", () => {
  const md = { kind: "md" as const, relPath: "guide/intro.md" };
  const asset = { kind: "static" as const, relPath: "css/app.css" };

  // Regression: the key was gen-only. The generation is bumped by a *site*
  // publishing, so a Worker deploy that changes the renderer never reached a site
  // that doesn't republish — it kept serving HTML built by the old renderer.
  it("pins a rendered page to the renderer that produced it", () => {
    expect(cacheKeyPath("u", "docs", 3, md, false)).toContain(`/g3/r${RENDER_VERSION}/guide/intro.md`);
  });

  it("leaves published bytes keyed by the generation alone", () => {
    expect(cacheKeyPath("u", "docs", 3, asset, false)).toBe("https://as-cache.internal/u/docs/g3/css/app.css");
    // ?raw is the markdown file itself, not our render — same rule applies.
    expect(cacheKeyPath("u", "docs", 3, md, true)).toBe("https://as-cache.internal/u/docs/g3/guide/intro.md?raw");
  });

  it("keeps generations and sites apart", () => {
    const a = cacheKeyPath("u", "docs", 3, md, false);
    expect(a).not.toBe(cacheKeyPath("u", "docs", 4, md, false));
    expect(a).not.toBe(cacheKeyPath("u", "other", 3, md, false));
    expect(a).not.toBe(cacheKeyPath("other", "docs", 3, md, false));
  });
});

describe("live reload", () => {
  it("tags a version with both the site generation and the renderer", () => {
    expect(versionTag(7)).toBe(`g7-r${RENDER_VERSION}`);
    expect(versionTag(7)).not.toBe(versionTag(8));
  });

  it("answers /_gen with the version, an ETag and no client caching", async () => {
    const res = genResponse("g7-r3", null);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("g7-r3");
    expect(res.headers.get("etag")).toBe('"g7-r3"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("returns 304 to a poll that already has the current version", async () => {
    expect(genResponse("g7-r3", '"g7-r3"').status).toBe(304);
    expect(genResponse("g7-r3", 'W/"g7-r3"').status).toBe(304);
    expect(genResponse("g7-r3", '"old", "g7-r3"').status).toBe(304);
    // A stale tag must get the new body so the page can compare and reload.
    const stale = genResponse("g8-r3", '"g7-r3"');
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("g8-r3");
  });

  it("hands the injected script its version and tuning via data attributes", () => {
    const tag = liveScript("g7-r3");
    expect(tag).toContain('data-version="g7-r3"');
    expect(tag).toContain(`baseMs&quot;:${LIVE.baseMs}`);
    expect(tag).toContain(LIVE_JS);
    // The built script must parse and keep the behaviours the server relies on.
    expect(() => new Function(LIVE_JS)).not.toThrow();
    expect(LIVE_JS).toContain('meta[name="agenthost-live"][content="off"]');
    expect(LIVE_JS).toContain("/_gen");
    expect(LIVE_JS).toContain("location.reload()");
  });
});
