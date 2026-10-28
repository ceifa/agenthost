import { describe, expect, it } from "vitest";
import { apexApp } from "../src/apex";
import { sha256Hex } from "../src/ids";
import { getMeta } from "../src/storage";
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
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(signed.headers).toEqual({ "content-length": "757603783", "content-type": "video/mp4" });
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
    const res = await f.call("POST", "/shares/demo/uploads/prepare/video.mp4", { bytes: 4 });
    expect(res.status).toBe(200);
    const body = await res.json<{ uploadUrl: string; uploadHeaders: Record<string, string>; url: string }>();
    expect(new URL(body.uploadUrl).pathname).toBe("/shares-bucket/sites/alice/demo/video.mp4");
    expect(body.uploadHeaders["content-type"]).toBe("video/mp4");
    const meta = (await getMeta(f.bucket, "alice", "demo"))!;
    expect(body.url).toBe(`https://alice-demo.example.com/?k=${meta.accessKey}`);
    expect(meta).toMatchObject({ generation: 0, bytes: 0, fileCount: 0, public: false, pending: { "video.mp4": { bytes: 4 } } });
  });

  it("commits a completed upload as a new generation and recounts the tree", async () => {
    const f = await fixture();
    f.json("_sites/alice/demo", { generation: 3, bytes: 2, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/index.html", { body: "hi" });
    await f.call("POST", "/shares/demo/uploads/prepare/media/video.mp4", { bytes: 4 });
    expect((await f.call("POST", "/shares/demo/uploads/complete/media/video.mp4")).status).toBe(409);
    f.records.set("sites/alice/demo/media/video.mp4", { body: "data" });
    const res = await f.call("POST", "/shares/demo/uploads/complete/media/video.mp4");
    expect(await res.json()).toEqual({ url: "https://alice-demo.example.com/?k=key", id: "demo", path: "media/video.mp4", bytes: 6, fileCount: 2 });
    const meta = (await getMeta(f.bucket, "alice", "demo"))!;
    expect(meta).toMatchObject({ generation: 4, bytes: 6, fileCount: 2 });
    expect(meta.pending).toBeUndefined();
    expect((await f.call("POST", "/shares/demo/uploads/complete/media/video.mp4")).status).toBe(404);
  });

  it("names the file only in the URL, encoded like any other path", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/shares/demo/uploads/prepare/m%C3%ADdia/v%C3%ADdeo%20%231.mp4", { bytes: 4 })).status).toBe(200);
    expect((await getMeta(f.bucket, "alice", "demo"))!.pending).toHaveProperty(["mídia/vídeo #1.mp4"]);
    f.records.set("sites/alice/demo/mídia/vídeo #1.mp4", { body: "data" });
    const res = await f.call("POST", "/shares/demo/uploads/complete/m%C3%ADdia/v%C3%ADdeo%20%231.mp4");
    expect(await res.json()).toMatchObject({ path: "mídia/vídeo #1.mp4", bytes: 4, fileCount: 1 });
  });

  it("deletes an upload whose size doesn't match the reservation", async () => {
    const f = await fixture();
    await f.call("POST", "/shares/demo/uploads/prepare/video.mp4", { bytes: 4 });
    f.records.set("sites/alice/demo/video.mp4", { body: "too long" });
    expect((await f.call("POST", "/shares/demo/uploads/complete/video.mp4")).status).toBe(400);
    expect(f.records.has("sites/alice/demo/video.mp4")).toBe(false);
    expect((await getMeta(f.bucket, "alice", "demo"))!.pending).toEqual({});
  });

  it("counts reservations against the account, replacing a file at the same path", async () => {
    const f = await fixture();
    f.json("_sites/alice/other", { generation: 1, bytes: LIMITS.free.perUser - 10, fileCount: 1, public: true, createdAt: 0, lastDeployAt: 0 });
    f.json("_sites/alice/demo", { generation: 1, bytes: 6, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/demo/a.bin", { body: "123456" });
    // Replacing a.bin frees its 6 bytes; 10 fit, 11 don't.
    expect((await f.call("POST", "/shares/demo/uploads/prepare/a.bin", { bytes: 11 })).status).toBe(413);
    expect((await f.call("POST", "/shares/demo/uploads/prepare/a.bin", { bytes: 10 })).status).toBe(200);
    // That reservation now holds the rest of the account.
    expect((await f.call("POST", "/shares/demo/uploads/prepare/b.bin", { bytes: 1 })).status).toBe(413);
    expect((await f.call("POST", "/shares/demo/uploads/prepare/big.bin", { bytes: MAX_FILE_BYTES + 1 })).status).toBe(413);
  });

  it("caps a paid account at 1 TB", async () => {
    const f = await fixture();
    f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "paid", createdAt: 0 });
    f.json("_sites/alice/other", { generation: 1, bytes: 1024 ** 4 - 10, fileCount: 1, public: true, createdAt: 0, lastDeployAt: 0 });
    expect((await f.call("POST", "/shares/demo/uploads/prepare/a.bin", { bytes: 11 })).status).toBe(413);
    expect((await f.call("POST", "/shares/demo/uploads/prepare/a.bin", { bytes: 10 })).status).toBe(200);
  });

  it("lets one file take the whole account: plans cap storage, not shares or files", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/shares/demo/uploads/prepare/all.bin", { bytes: LIMITS.free.perUser })).status).toBe(200);
    expect((await f.call("POST", "/shares/other/uploads/prepare/one.bin", { bytes: 1 })).status).toBe(413);
  });

  it.each([
    ["no JSON", "a.bin", undefined],
    ["no path", "", { bytes: 1 }],
    ["an unsafe path", "..%2Fx", { bytes: 1 }],
    ["the live-reload path", "_gen", { bytes: 1 }],
    ["a zero size", "a.bin", { bytes: 0 }],
  ])("refuses %s without reserving anything", async (_, path, body) => {
    const f = await fixture();
    expect((await f.call("POST", `/shares/demo/uploads/prepare/${path}`, body)).status).toBe(400);
    expect(f.records.has("_sites/alice/demo")).toBe(false);
  });

  it("sweeps uploads never completed, along with whatever landed", async () => {
    const f = await fixture();
    f.json("_sites/alice/demo", {
      generation: 1, bytes: 2, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 1000,
      pending: { "old.mp4": { bytes: 4, expiresAt: 1500 }, "new.mp4": { bytes: 4, expiresAt: 5000 } },
    });
    f.records.set("sites/alice/demo/index.html", { body: "hi" });
    f.records.set("sites/alice/demo/old.mp4", { body: "data" });
    await runRetentionSweep(f.env, 2000);
    expect(f.records.has("sites/alice/demo/old.mp4")).toBe(false);
    expect(f.records.has("sites/alice/demo/index.html")).toBe(true);
    expect(Object.keys((await getMeta(f.bucket, "alice", "demo"))!.pending!)).toEqual(["new.mp4"]);
  });
});
