import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublish } from "../src/publish";
import { sanitizeSiteId, sha256Hex, siteHost } from "../src/ids";
import { testBucket } from "./test-bucket";

afterEach(() => vi.unstubAllGlobals());

describe("share ids", () => {
  // Regression: `report.md` was kept as is and produced `{user}-report.md.{apex}`,
  // two labels deep, which the single-level wildcard certificate doesn't cover.
  it.each([
    ["report.md", "report-md"],
    ["v1.2.3", "v1-2-3"],
    ["Notes.", "notes"],
    [".hidden", "hidden"],
    ["my_site", "my_site"],
    ["a b/c", "a-b-c"],
  ])("maps %s to the single DNS label %s", (raw, id) => {
    expect(sanitizeSiteId(raw)).toBe(id);
    expect(siteHost("alice", id, "example.com").split(".")).toHaveLength(3);
  });

  it.each(["", ".", "..", "---", "x".repeat(33)])("refuses %j", raw => {
    expect(sanitizeSiteId(raw)).toBeNull();
  });

  it("publishes a dotted id under its hyphenated name and says so", async () => {
    const f = testBucket();
    f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0 });
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array> { constructor(_length: number) { super(); } });
    const res = await handlePublish(new Request("https://example.com/shares/report.md", {
      method: "PUT", body: "# Home", headers: { authorization: "Bearer alice.owner", "content-length": "6" },
    }), f.env, "report.md");
    expect(await res.json()).toMatchObject({ id: "report-md", url: expect.stringMatching(/^https:\/\/alice-report-md\.example\.com\//) });
    expect(f.records.has("_sites/alice/report-md")).toBe(true);
  });
});
