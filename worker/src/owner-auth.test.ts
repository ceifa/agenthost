import { afterEach, describe, expect, it, vi } from "vitest";
import { apexApp } from "./apex";
import { sha256Hex } from "./ids";
import { testBucket } from "./test-bucket";
import type { Env } from "./env";

afterEach(() => vi.unstubAllGlobals());

const credentialsFileHeaders = { authorization: "Bearer owner", "x-agenthost-user": "alice" };

async function fixture() {
  const f = testBucket();
  f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, legacySiteIds: [] }, true);
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array> { constructor(_length: number) { super(); } });
  const env = {
    ...f.env,
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_BUCKET_NAME: "assets-bucket",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
  } as Env;
  const call = (url: string, init: RequestInit = {}, headers: Record<string, string> = credentialsFileHeaders) =>
    apexApp.fetch(new Request(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } }), env);
  return { ...f, call };
}

describe("owner endpoints authenticated by the credentials file headers", () => {
  it("publish, rotate, make public and claim", async () => {
    const { call } = await fixture();
    const pub = await call("https://example.com/publish?id=docs", { method: "POST", body: "# Hi" });
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ username: "alice", siteId: "docs", url: "https://alice-docs.example.com/" });

    const rotate = await call("https://example.com/key/rotate?id=docs", { method: "POST" });
    expect(rotate.status).toBe(200);
    expect((await rotate.json<{ shareUrl: string }>()).shareUrl).toMatch(/^https:\/\/alice-docs\.example\.com\/\?k=/);

    expect(await (await call("https://example.com/key/public?id=docs", { method: "POST" })).json()).toEqual({ ok: true, public: true });
    expect(await (await call("https://example.com/claim?email=a@example.com", { method: "POST" })).json()).toEqual({
      ok: true,
      username: "alice",
      email: "a@example.com",
    });
  });

  it("initiate, complete and delete an asset", async () => {
    const { call, records } = await fixture();
    const created = await call("https://example.com/asset", {
      method: "POST",
      body: JSON.stringify({ name: "a.bin", bytes: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(200);
    const { assetId, completeUrl } = await created.json<{ assetId: string; completeUrl: string }>();
    expect(completeUrl).toBe(`https://example.com/a/alice/${assetId}/complete?username=alice`);

    records.set(`assets/alice/${assetId}/blob`, { body: "abc" });
    const done = await call(completeUrl, { method: "POST" });
    expect(await done.json()).toEqual({ ok: true, url: `https://example.com/a/alice/${assetId}`, name: "a.bin", bytes: 3 });

    const del = await call(`https://example.com/a/alice/${assetId}`, { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true });
    expect(records.has(`assets/alice/${assetId}/blob`)).toBe(false);
  });

  it("rejects the token without the username header", async () => {
    const { call } = await fixture();
    const res = await call("https://example.com/key/public?id=docs", { method: "POST" }, { authorization: "Bearer owner" });
    expect(res.status).toBe(401);
  });
});
