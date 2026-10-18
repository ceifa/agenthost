import { describe, expect, it } from "vitest";
import { apexApp } from "../src/apex";
import { sha256Hex } from "../src/ids";
import { testBucket } from "./test-bucket";
import { attachmentDisposition, safeAssetName } from "../src/assets";
import { signDirectDownload, signDirectUpload } from "../src/r2-signed";
import { assetDownloadHtml } from "../src/templates";
import type { Env } from "../src/env";

const env = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "assets-bucket",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
} as Env;

describe("direct R2 asset transfer", () => {
  it("signs an exact-size PUT straight to R2", async () => {
    const signed = await signDirectUpload(env, "assets/user/id/blob", {
      bytes: 757_603_783,
      contentType: "video/mp4",
      contentDisposition: attachmentDisposition("Universe.mp4"),
    });
    const url = new URL(signed.url);

    expect(url.host).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/assets-bucket/assets/user/id/blob");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-disposition;content-length;content-type;host",
    );
    expect(signed.headers["content-length"]).toBe("757603783");
    expect(signed.headers["content-type"]).toBe("video/mp4");
  });

  it("signs downloads on R2 rather than the Worker origin", async () => {
    const signed = await signDirectDownload(env, "assets/user/id/blob");
    const page = assetDownloadHtml({
      name: "Universe.mp4",
      bytes: 757_603_783,
      contentType: "video/mp4",
      downloadUrl: signed.url,
      shareUrl: "https://agenthost.page/a/user/id?k=secret",
    });

    expect(signed.url).toContain(".r2.cloudflarestorage.com/");
    expect(page).toContain(`href="${signed.url.replace(/&/g, "&amp;")}"`);
    expect(page).not.toContain("/download");
    expect(page).toContain(">Download</a>");
  });

  it("sanitizes names before putting them in metadata and headers", () => {
    expect(safeAssetName("../folder/video final.mp4")).toBe("video final.mp4");
    expect(safeAssetName("bad\r\nname.mp4")).toBeNull();
    expect(attachmentDisposition("vídeo final.mp4")).toContain("filename*=UTF-8''v%C3%ADdeo%20final.mp4");
  });
});

describe("asset share page", () => {
  async function fixture(overrides: Record<string, unknown> = {}, limited = false) {
    const f = testBucket();
    f.json("_assets/alice/abc/_meta", {
      id: "abc", username: "alice", name: "demo.mp4", contentType: "video/mp4", bytes: 4, objectKey: "assets/alice/abc/blob",
      keyHash: await sha256Hex("key"), public: false, status: "ready", createdAt: 0, lastDeployAt: 0, ...overrides,
    }, true);
    f.records.set("assets/alice/abc/blob", { body: "data" });
    const testEnv = { ...f.env, ...env, ACCESS_LIMITER: { limit: async () => ({ success: !limited }) } } as Env;
    const get = (path: string, headers?: HeadersInit) => apexApp.fetch(new Request(`https://example.com/a/alice/abc${path}`, { headers }), testEnv);
    return { ...f, get };
  }

  it("prompts for the key, then logs a reader in with a path-scoped cookie", async () => {
    const f = await fixture();
    const prompt = await f.get("");
    expect(prompt.status).toBe(401);
    expect(prompt.headers.get("cache-control")).toBe("no-store");
    expect(await prompt.text()).not.toContain("Incorrect key");

    const wrong = await f.get("?k=nope");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Incorrect key");

    const login = await f.get("?k=key&x=1");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/a/alice/abc?x=1");
    expect(login.headers.get("set-cookie")).toMatch(/^aa_auth_abc=key; Path=\/a\/alice\/abc; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);

    const page = await f.get("", { cookie: "aa_auth_abc=key" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("demo.mp4");
    expect(html).toContain("https://example.com/a/alice/abc?k=key");
  });

  it("throttles wrong keys", async () => {
    const f = await fixture({}, true);
    expect((await f.get("?k=nope")).status).toBe(429);
    expect((await f.get("")).status).toBe(401);
  });

  it("serves public assets without a key and pending ones as 425", async () => {
    expect((await (await fixture({ public: true })).get("")).status).toBe(200);
    expect((await (await fixture({ status: "pending" })).get("", { cookie: "aa_auth_abc=key" })).status).toBe(425);
    expect((await (await fixture()).get("/../nope")).status).toBe(404);
  });
});


describe("asset creation", () => {
  it.each(["null", "[]", "{not json"])("answers a %s body with 400", async (raw) => {
    const f = testBucket();
    f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, legacySiteIds: [] }, true);
    const res = await apexApp.fetch(new Request("https://example.com/asset?username=alice", {
      method: "POST", body: raw, headers: { authorization: "Bearer owner", "content-type": "application/json" },
    }), { ...f.env, ...env } as Env);
    expect(res.status).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });

  it("answers with a url that already carries the access key", async () => {
    const f = testBucket();
    f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, legacySiteIds: [] }, true);
    const res = await apexApp.fetch(new Request("https://example.com/asset?username=alice", {
      method: "POST",
      body: JSON.stringify({ name: "demo.mp4", bytes: 10, contentType: "video/mp4" }),
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
    }), { ...f.env, ...env } as Env);
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty("shareUrl");
    expect(body).not.toHaveProperty("accessKey");
    const url = new URL(body.url as string);
    expect(url.searchParams.get("k")).toBeTruthy();
    const open = await apexApp.fetch(new Request(url), { ...f.env, ...env } as Env);
    expect(open.status).toBe(302);
    expect(open.headers.get("set-cookie")).toContain("aa_auth_");
  });
});
