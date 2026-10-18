import { describe, expect, it } from "vitest";
import { apexApp } from "../src/apex";
import { getMeta } from "../src/storage";
import { sha256Hex } from "../src/ids";
import { testBucket } from "./test-bucket";

describe("POST /key/public", () => {
  async function setPublic(query: string, body?: unknown) {
    const f = testBucket();
    f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, legacySiteIds: [] }, true);
    f.json("_sites/alice/docs", { generation: 1, public: false, keyHash: "hash", lastDeployAt: 0 }, true);
    const res = await apexApp.fetch(new Request(`https://example.com/key/public?username=alice&id=docs${query}`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), f.env);
    return { res, meta: await getMeta(f.bucket, "alice", "docs") };
  }

  it.each([
    ["no value", "", undefined],
    ["an unrecognized query value", "&public=yes", undefined],
    ["a non-boolean body value", "", { public: 1 }],
  ])("rejects %s without touching the site", async (_, query, body) => {
    const { res, meta } = await setPublic(query, body);
    expect(res.status).toBe(400);
    expect(meta?.public).toBe(false);
  });

  it.each([
    ["&public=true", undefined, true],
    ["&public=false", undefined, false],
    ["", { public: true }, true],
    ["&public=true", { public: false }, false],
  ])("applies %s %j", async (query, body, expected) => {
    const { res, meta } = await setPublic(query, body);
    expect(await res.json()).toEqual({ ok: true, public: expected });
    expect(meta?.public).toBe(expected);
  });
});
