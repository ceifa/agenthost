import { describe, expect, it } from "vitest";
import { apexApp } from "../src/apex";
import { sha256Hex } from "../src/ids";
import { getMeta, reconcileUploads, userUsage } from "../src/storage";
import { runRetentionSweep } from "../src/sweep";
import { LIMITS, MAX_FILE_BYTES } from "../src/config";
import { signDirectUpload } from "../src/r2-signed";
import { testBucket } from "./test-bucket";
import type { Env } from "../src/env";

const r2 = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "shares-bucket",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
};

describe("direct R2 upload signing", () => {
  it("signs an exact-size PUT straight to the file's key in R2", async () => {
    const signed = await signDirectUpload(r2 as Env, "sites/user/demo/video.mp4", { bytes: 757_603_783, contentType: "video/mp4", expiresIn: 900 });
    const url = new URL(signed.url);
    expect(url.host).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/shares-bucket/sites/user/demo/video.mp4");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    // No content-disposition: the file opens inline unless a reader asks for ?download.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;if-none-match");
    expect(signed.headers).toEqual({ "content-length": "757603783", "content-type": "video/mp4", "if-none-match": "*" });
  });
});

async function fixture() {
  const f = testBucket();
  f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0 });
  const env = { ...f.env, ...r2 } as Env;
  const call = (method: string, path: string, body?: unknown) => apexApp.fetch(new Request(`https://example.com${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: "Bearer alice.owner", "content-type": "application/json" },
  }), env);
  return { ...f, env, call };
}

describe("uploads into a share", () => {
  it("creates the share, reserves the bytes and hands back a keyed url", async () => {
    const f = await fixture();
    const res = await f.call("POST", "/shares/demo/uploads", { path: "video.mp4", bytes: 4 });
    expect(res.status).toBe(200);
    const body = await res.json<{ uploadUrl: string; uploadHeaders: Record<string, string>; url: string }>();
    expect(new URL(body.uploadUrl).pathname).toBe("/shares-bucket/sites/alice/demo/video.mp4");
    expect(body.uploadHeaders["content-type"]).toBe("video/mp4");
    const meta = (await getMeta(f.bucket, "alice", "demo"))!;
    expect(body.url).toBe(`https://alice-demo.example.com/?k=${meta.accessKey}`);
    expect(meta).toMatchObject({ generation: 0, bytes: 0, fileCount: 0, public: false, pending: { "video.mp4": { bytes: 4 } } });
  });

  it("recognizes an upload on the next owner read without a completion call", async () => {
    const f = await fixture();
    f.json("_sites/alice/demo", { generation: 3, bytes: 2, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/index.html", { body: "hi" });
    await f.call("POST", "/shares/demo/uploads", { path: "media/video.mp4", bytes: 4 });
    expect(await (await f.call("GET", "/shares/demo")).json()).toMatchObject({ bytes: 2, fileCount: 1 });
    f.records.set("sites/alice/demo/media/video.mp4", { body: "data" });
    const res = await f.call("GET", "/shares/demo");
    expect(await res.json()).toMatchObject({ url: "https://alice-demo.example.com/?k=key", id: "demo", bytes: 6, fileCount: 2 });
    const meta = (await getMeta(f.bucket, "alice", "demo"))!;
    expect(meta).toMatchObject({ generation: 4, bytes: 6, fileCount: 2 });
    expect(meta.pending).toBeUndefined();
    await f.call("GET", "/shares/demo");
    expect((await getMeta(f.bucket, "alice", "demo"))!.generation).toBe(4);
  });

  it.each(["new!", "old!"])("recognizes the new R2 version, not the previous object (replacement: %s)", async body => {
    const f = await fixture();
    f.json("_sites/alice/demo", { generation: 3, bytes: 4, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/video.mp4", { body: "old!" });
    const reservation = await f.call("POST", "/shares/demo/uploads", { path: "video.mp4", bytes: 4 });
    expect((await reservation.json<{ uploadHeaders: Record<string, string> }>()).uploadHeaders["if-match"]).toBe('"test-etag"');
    await f.call("GET", "/shares/demo");
    expect((await getMeta(f.bucket, "alice", "demo"))!.pending).toHaveProperty("video.mp4");
    expect((await getMeta(f.bucket, "alice", "demo"))!.generation).toBe(3);
    f.records.set("sites/alice/demo/video.mp4", { body });
    expect(await (await f.call("GET", "/shares/demo")).json()).toMatchObject({ bytes: 4, fileCount: 1 });
    expect((await getMeta(f.bucket, "alice", "demo"))!.pending).toBeUndefined();
    expect((await getMeta(f.bucket, "alice", "demo"))!.generation).toBe(4);
  });

  it("recognizes a completed upload in the share list", async () => {
    const f = await fixture();
    await f.call("POST", "/shares/demo/uploads", { path: "video.mp4", bytes: 4 });
    f.records.set("sites/alice/demo/video.mp4", { body: "data" });
    expect(await (await f.call("GET", "/shares")).json()).toMatchObject({ shares: [{ id: "demo", bytes: 4, fileCount: 1 }] });
    expect((await getMeta(f.bucket, "alice", "demo"))!.pending).toBeUndefined();
  });

  it("refuses overlapping reservations at the same path", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/shares/demo/uploads", { path: "video.mp4", bytes: 4 })).status).toBe(200);
    expect((await f.call("POST", "/shares/demo/uploads", { path: "video.mp4", bytes: 8 })).status).toBe(409);
  });

  it("counts reservations against the account, replacing a file at the same path", async () => {
    const f = await fixture();
    f.json("_sites/alice/other", { generation: 1, bytes: LIMITS.free.perUser - 10, fileCount: 1, public: true, createdAt: 0, lastDeployAt: 0 });
    f.json("_sites/alice/demo", { generation: 1, bytes: 6, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/a.bin", { body: "123456" });
    // Replacing a.bin frees its 6 bytes; 10 fit, 11 don't.
    expect((await f.call("POST", "/shares/demo/uploads", { path: "a.bin", bytes: 11 })).status).toBe(413);
    expect((await f.call("POST", "/shares/demo/uploads", { path: "a.bin", bytes: 10 })).status).toBe(200);
    // That reservation now holds the rest of the account.
    expect((await f.call("POST", "/shares/demo/uploads", { path: "b.bin", bytes: 1 })).status).toBe(413);
    expect((await f.call("POST", "/shares/demo/uploads", { path: "big.bin", bytes: MAX_FILE_BYTES + 1 })).status).toBe(413);
  });

  it("counts a replacement only once and never frees space before a smaller upload arrives", async () => {
    const f = await fixture();
    f.json("_sites/alice/demo", { generation: 1, bytes: 6, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/a.bin", { body: "123456" });
    await f.call("POST", "/shares/demo/uploads", { path: "a.bin", bytes: 10 });
    expect(await userUsage(f.bucket, "alice")).toBe(10);
    f.records.set("sites/alice/demo/a.bin", { body: "0123456789" });
    await f.call("GET", "/shares/demo");
    expect(await userUsage(f.bucket, "alice")).toBe(10);
    await f.call("POST", "/shares/demo/uploads", { path: "a.bin", bytes: 2 });
    expect(await userUsage(f.bucket, "alice")).toBe(10);
    f.records.set("sites/alice/demo/a.bin", { body: "hi" });
    await f.call("GET", "/shares/demo");
    expect(await userUsage(f.bucket, "alice")).toBe(2);
  });

  it("releases abandoned reservations without deleting the previous object", async () => {
    const f = await fixture();
    f.json("_sites/alice/demo", { generation: 1, bytes: 4, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/a.bin", { body: "data" });
    await f.call("POST", "/shares/demo/uploads", { path: "a.bin", bytes: 8 });
    await f.call("POST", "/shares/demo/uploads", { path: "never.bin", bytes: 2 });
    const meta = (await getMeta(f.bucket, "alice", "demo"))!;
    const next = await reconcileUploads(f.bucket, "alice", "demo", meta, Date.now() + 2 * 86400000);
    expect(next).toMatchObject({ bytes: 4, fileCount: 1 });
    expect(next.pending).toBeUndefined();
    expect(f.records.get("sites/alice/demo/a.bin")!.body).toBe("data");
    expect(await userUsage(f.bucket, "alice")).toBe(4);
  });

  it("reclaims expired quota on another share before admitting a new reservation", async () => {
    const f = await fixture();
    f.json("_sites/alice/abandoned", { generation: 1, bytes: 0, fileCount: 0, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0, pending: { "a.bin": { bytes: LIMITS.free.perUser, expiresAt: 0 } } });
    expect((await f.call("POST", "/shares/demo/uploads", { path: "a.bin", bytes: LIMITS.free.perUser })).status).toBe(200);
    expect((await getMeta(f.bucket, "alice", "abandoned"))!.pending).toBeUndefined();
  });

  it("lets one file take the whole account: plans cap storage, not shares or files", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/shares/demo/uploads", { path: "all.bin", bytes: LIMITS.free.perUser })).status).toBe(200);
    expect((await f.call("POST", "/shares/other/uploads", { path: "one.bin", bytes: 1 })).status).toBe(413);
  });

  it.each([
    ["no JSON", undefined],
    ["an unsafe path", { path: "../x", bytes: 1 }],
    ["the live-reload path", { path: "_gen", bytes: 1 }],
    ["a zero size", { path: "a.bin", bytes: 0 }],
  ])("refuses %s without reserving anything", async (_, body) => {
    const f = await fixture();
    expect((await f.call("POST", "/shares/demo/uploads", body)).status).toBe(400);
    expect(f.records.has("_sites/alice/demo")).toBe(false);
  });

  it("sweeps abandoned reservations without deleting successful uploads", async () => {
    const f = await fixture();
    f.json("_sites/alice/demo", {
      generation: 1, bytes: 2, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 1000,
      pending: { "old.mp4": { bytes: 4, expiresAt: 1500 }, "new.mp4": { bytes: 4, expiresAt: 5000 } },
    });
    f.records.set("sites/alice/demo/index.html", { body: "hi" });
    f.records.set("sites/alice/demo/old.mp4", { body: "data" });
    await runRetentionSweep(f.env, 2000);
    expect(f.records.has("sites/alice/demo/old.mp4")).toBe(true);
    expect(await getMeta(f.bucket, "alice", "demo")).toMatchObject({ bytes: 6, fileCount: 2, pending: { "new.mp4": { bytes: 4 } } });
    expect(f.records.has("sites/alice/demo/index.html")).toBe(true);
    expect(Object.keys((await getMeta(f.bucket, "alice", "demo"))!.pending!)).toEqual(["new.mp4"]);
  });
});
