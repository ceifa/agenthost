import { describe, expect, it } from "vitest";
import { cacheKeyPath } from "./serve";
import { RENDER_VERSION } from "./config";

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
