import { describe, expect, it } from "vitest";
import { apexApp } from "../src/apex";
import { getMeta, getUser } from "../src/storage";
import { sha256Hex } from "../src/ids";
import { testBucket } from "./test-bucket";

async function fixture(meta: Record<string, unknown> = {}) {
  const f = testBucket();
  f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0 });
  f.json("_sites/alice/docs", { generation: 1, public: false, accessKey: "key", bytes: 5, fileCount: 2, createdAt: 0, lastDeployAt: 0, ...meta });
  f.records.set("sites/alice/docs/index.html", { body: "hi" });
  f.records.set("sites/alice/docs/a b.css", { body: "a{}" });
  const call = (method: string, path: string, body?: unknown, token = "alice.owner") => apexApp.fetch(new Request(`https://example.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), f.env);
  return { ...f, call };
}

describe("owner token", () => {
  it.each([
    ["no username in it", "owner", 401],
    ["the wrong secret", "alice.nope", 403],
    ["an unknown account", "bob.owner", 403],
  ])("refuses a token with %s", async (_, token, status) => {
    const f = await fixture();
    expect((await f.call("GET", "/shares/docs", undefined, token)).status).toBe(status);
  });
});

describe("/shares", () => {
  it("returns a share's keyed url whenever asked", async () => {
    const f = await fixture();
    expect(await (await f.call("GET", "/shares/docs")).json()).toMatchObject({ id: "docs", url: "https://alice-docs.example.com/?k=key", public: false });
    const list = await (await f.call("GET", "/shares")).json<{ shares: { id: string; url: string }[] }>();
    expect(list.shares).toEqual([expect.objectContaining({ id: "docs", url: "https://alice-docs.example.com/?k=key" })]);
    expect((await f.call("GET", "/shares/nope")).status).toBe(404);
  });

  it.each([undefined, {}, { public: "true" }])("refuses %j as a visibility change", async (body) => {
    const f = await fixture();
    expect((await f.call("PATCH", "/shares/docs", body)).status).toBe(400);
    expect((await getMeta(f.bucket, "alice", "docs"))!.public).toBe(false);
  });

  it("makes a share public, then rotating the key makes it private again", async () => {
    const f = await fixture();
    expect(await (await f.call("PATCH", "/shares/docs", { public: true })).json()).toMatchObject({ public: true, url: "https://alice-docs.example.com/" });
    const rotated = await (await f.call("POST", "/shares/docs/key")).json<{ url: string; public: boolean }>();
    const key = new URL(rotated.url).searchParams.get("k");
    expect(rotated.public).toBe(false);
    expect(key).toBeTruthy();
    expect(key).not.toBe("key");
    expect((await getMeta(f.bucket, "alice", "docs"))!.accessKey).toBe(key);
  });

  it("swaps a key stored only as a hash for one it can hand back", async () => {
    const f = await fixture({ accessKey: undefined, keyHash: await sha256Hex("old") });
    expect(await (await f.call("GET", "/shares/docs")).json()).toMatchObject({ url: "https://alice-docs.example.com/" });
    await f.call("POST", "/shares/docs/key");
    const meta = (await getMeta(f.bucket, "alice", "docs"))!;
    expect(meta.keyHash).toBeUndefined();
    expect(meta.accessKey).toBeTruthy();
  });

  it("deletes one file as a new generation, then the whole share", async () => {
    const f = await fixture();
    expect(await (await f.call("DELETE", "/shares/docs/files/a%20b.css")).json()).toMatchObject({ bytes: 2, fileCount: 1 });
    expect(f.records.has("sites/alice/docs/a b.css")).toBe(false);
    expect((await getMeta(f.bucket, "alice", "docs"))!.generation).toBe(2);
    expect((await f.call("DELETE", "/shares/docs/files/a%20b.css")).status).toBe(404);
    expect((await f.call("DELETE", "/shares/docs/files/..%2F..%2Fx")).status).toBe(404);
    expect(await (await f.call("DELETE", "/shares/docs")).json()).toEqual({ ok: true });
    expect([...f.records.keys()].filter(k => k.includes("/docs"))).toEqual([]);
  });
});

describe("PATCH /account", () => {
  it("refuses an email too long to fit the account record", async () => {
    const f = await fixture();
    expect((await f.call("PATCH", "/account", { email: `${"a".repeat(7000)}@x.com` })).status).toBe(400);
    expect(await (await f.call("PATCH", "/account", { email: "me@x.com" })).json()).toEqual({ username: "alice", email: "me@x.com" });
    expect((await getUser(f.bucket, "alice"))!.email).toBe("me@x.com");
  });
});
