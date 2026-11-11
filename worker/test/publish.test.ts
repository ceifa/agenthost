import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublish } from "../src/publish";
import { apexApp } from "../src/apex";
import { handleAdmin } from "../src/admin";
import { getMeta, getUser, userUsage } from "../src/storage";
import { clientIp, sha256Hex } from "../src/ids";
import { LIMITS, MAX_FILES } from "../src/config";
import { testBucket } from "./test-bucket";
import { gzip, header, tar } from "./test-tar";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const f = testBucket();
  f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0 });
  const request = (body: BodyInit, headers: Record<string, string> = {}) => handlePublish(new Request("https://example.com/shares/docs", {
    method: "PUT", body, headers: { authorization: "Bearer alice.owner", "content-type": "text/markdown", ...headers },
    ...({ duplex: "half" } as object),
  }), f.env, "docs");
  // Real length validation is exercised in the workerd smoke check. This shim
  // lets unit tests inspect backpressure, cancellation and inventory writes.
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array> { constructor(_length: number) { super(); } });
  return { ...f, request };
}

describe("efficient single-file publishing", () => {
  it("does not store a file advertised as empty", async () => {
    const f = await fixture();
    expect((await f.request("# Home", { "content-length": "0" })).status).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("streams known-length files and commits generation with one metadata PUT", async () => {
    const f = await fixture();
    const res = await f.request("# Home", { "content-length": "6" });
    expect(res.status).toBe(200);
    expect(f.put.mock.calls[0]![1]).toBeInstanceOf(ReadableStream);
    expect(f.put.mock.calls.map(([key]) => key)).toEqual(["sites/alice/docs/README.md", "_sites/alice/docs"]);
    expect((await getMeta(f.bucket, "alice", "docs"))!.generation).toBe(1);
    const again = await f.request("# Next", { "content-length": "6" });
    expect(again.status).toBe(200);
    expect((await getMeta(f.bucket, "alice", "docs"))!.generation).toBe(2);
    expect(f.records.has("sites/alice/docs/_gen")).toBe(false);
  });

  it.each([true, false])("enforces remaining account quota before writing (known length: %s)", async known => {
    const f = await fixture();
    f.json("_sites/alice/other", { generation: 1, bytes: LIMITS.free.perUser - 4 });
    const res = await f.request("# Too large", known ? { "content-length": "11" } : {});
    expect(res.status).toBe(413);
    expect(f.put).not.toHaveBeenCalled();
  });

  it("aborts the producer after an R2 rejection instead of hanging on backpressure", async () => {
    const f = await fixture();
    f.put.mockRejectedValueOnce(new Error("R2 unavailable"));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("# " + "x".repeat(1024))); }, cancel });
    const res = await f.request(body, { "content-length": "4096" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad archive: R2 unavailable" });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(f.records.has("_sites/alice/docs")).toBe(false);
  });
});

describe("archive publishing", () => {
  async function archiveFixture() {
    const f = await fixture();
    const post = (body: BodyInit | null, opts: { owner?: boolean; query?: string; headers?: Record<string, string> } = {}) =>
      handlePublish(new Request(`https://example.com/shares/docs?${opts.query ?? ""}`, {
        method: "PUT", body, headers: { ...(opts.owner === false ? {} : { authorization: "Bearer alice.owner" }), ...opts.headers },
        ...({ duplex: "half" } as object),
      }), f.env, "docs");
    const error = async (res: Response) => ({ status: res.status, ...(await res.json<{ error: string }>()) });
    return { ...f, post, error };
  }

  it("mints an account, an access key and a generation on an anonymous publish", async () => {
    const f = await archiveFixture();
    const res = await f.post(tar([{ name: "./index.html", body: "<p>hi</p>" }, { name: "css/app.css", body: "a{}" }]), { owner: false });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, string | number>>();
    const username = body.username as string;
    const key = new URL(body.url as string).searchParams.get("k")!;
    expect(Object.keys(body).sort()).toEqual(["bytes", "fileCount", "id", "ownerToken", "url", "username"]);
    expect(body).toMatchObject({ id: "docs", fileCount: 2, bytes: 12, url: `https://${username}-docs.example.com/?k=${key}` });
    // One string carries the account: `{username}.{secret}`, with only the secret hashed.
    const [tokenUser, secret] = (body.ownerToken as string).split(".");
    expect(tokenUser).toBe(username);
    const user = (await getUser(f.bucket, username))!;
    expect(user).toMatchObject({ plan: "free", tokenHash: await sha256Hex(secret!) });
    const meta = (await getMeta(f.bucket, username, "docs"))!;
    expect(meta).toMatchObject({ generation: 1, bytes: 12, fileCount: 2, public: false, accessKey: key });
    expect(f.records.get(`sites/${username}/docs/css/app.css`)).toMatchObject({ body: "a{}", httpMetadata: { contentType: "text/css; charset=utf-8" } });
  });

  it("keeps the access key on redeploy, returns it again and deletes files the new archive dropped", async () => {
    const f = await archiveFixture();
    const first = await (await f.post(tar([{ name: "index.html", body: "one" }, { name: "old.css", body: "x" }]))).json<Record<string, unknown>>();
    const second = await (await f.post(await gzip(tar([{ name: "index.html", body: "two" }])))).json<Record<string, unknown>>();
    const key = new URL(first.url as string).searchParams.get("k")!;
    expect(key).toBeTruthy();
    expect(second).not.toHaveProperty("ownerToken");
    expect(second).toMatchObject({ fileCount: 1, bytes: 3, url: `https://alice-docs.example.com/?k=${key}` });
    expect(f.records.has("sites/alice/docs/old.css")).toBe(false);
    expect(f.records.get("sites/alice/docs/index.html")!.body).toBe("two");
    expect((await getMeta(f.bucket, "alice", "docs"))!).toMatchObject({ generation: 2, accessKey: key });
  });

  it("merges into the tree, counting a replaced file once", async () => {
    const f = await archiveFixture();
    await f.post(tar([{ name: "index.html", body: "one" }, { name: "video.mp4", body: "12345" }]));
    const res = await f.post(tar([{ name: "index.html", body: "three" }, { name: "new.css", body: "a" }]), { query: "mode=merge" });
    expect(await res.json()).toMatchObject({ fileCount: 3, bytes: 11 });
    expect(f.records.get("sites/alice/docs/video.mp4")!.body).toBe("12345");
    expect(f.records.get("sites/alice/docs/index.html")!.body).toBe("three");
    expect((await getMeta(f.bucket, "alice", "docs"))!).toMatchObject({ generation: 2, fileCount: 3, bytes: 11 });
  });

  it("leaves an upload in flight alone when replacing the tree", async () => {
    const f = await archiveFixture();
    f.json("_sites/alice/docs", { generation: 1, bytes: 1, fileCount: 1, accessKey: "key", public: false, createdAt: 0, lastDeployAt: 0, pending: { "big.mp4": { bytes: 4, expiresAt: 1e15 } } });
    f.records.set("sites/alice/docs/big.mp4", { body: "data" });
    f.records.set("sites/alice/docs/old.html", { body: "x" });
    expect((await f.post(tar([{ name: "index.html", body: "hi" }]))).status).toBe(200);
    expect(f.records.has("sites/alice/docs/big.mp4")).toBe(true);
    expect(f.records.has("sites/alice/docs/old.html")).toBe(false);
    expect((await getMeta(f.bucket, "alice", "docs"))!).toMatchObject({ fileCount: 1, bytes: 2, pending: { "big.mp4": { bytes: 4 } } });
  });

  it("skips Finder cruft, directories and the live-reload probe path", async () => {
    const f = await archiveFixture();
    const res = await f.post(tar([
      { name: "dir/", flag: "5" }, { name: "._index.html", body: "x" }, { name: "a/.DS_Store", body: "x" },
      { name: "_gen", body: "99" }, { name: "index.html", body: "ok" },
    ]));
    expect(await res.json()).toMatchObject({ fileCount: 1, bytes: 2 });
    expect([...f.records.keys()].filter(k => k.startsWith("sites/"))).toEqual(["sites/alice/docs/index.html"]);
  });

  it.each<{ name: string; body: () => Uint8Array; query?: string; headers?: Record<string, string>; status: number; error: string | RegExp }>([
    { name: "a symlink", body: () => tar([{ name: "link", flag: "2" }]), status: 400, error: "links are not allowed (link)" },
    { name: "a parent path", body: () => tar([{ name: "../evil.html", body: "x" }]), status: 400, error: "unsafe path rejected: ../evil.html" },
    { name: "no files", body: () => tar([{ name: "dir/", flag: "5" }]), status: 400, error: "archive contained no files" },
    { name: "too many files", body: () => tar(Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `${i}.txt`, body: "x" }))), status: 413, error: `too many files; max is ${MAX_FILES}` },
    { name: "an entry bigger than the account", body: () => header("big.bin", LIMITS.free.perUser + 1), status: 413, error: `entry big.bin declares ${LIMITS.free.perUser + 1} bytes; max is ${LIMITS.free.perUser}` },
    { name: "a zip", body: () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), status: 400, error: "zip is not supported — send a tar (tar cf - -C ./dist .)" },
    { name: "binary garbage", body: () => new Uint8Array([0, 1, 2, 3]), status: 400, error: "unrecognized body — send a tar, a .md/.html document, or PUT it to /shares/{id}/files/{path}" },
    { name: "garbage labelled as a tarball", body: () => new TextEncoder().encode("not gzip"), headers: { "content-type": "application/gzip" }, status: 400, error: /^bad archive: / },
    { name: "an unknown mode", body: () => tar([{ name: "a.txt", body: "a" }]), query: "mode=append", status: 400, error: "mode must be replace or merge" },
  ])("rejects $name without committing", async ({ body, query, headers, status, error }) => {
    const f = await archiveFixture();
    const res = await f.error(await f.post(body(), { query, headers }));
    expect(res.status).toBe(status);
    if (typeof error === "string") expect(res.error).toBe(error);
    else expect(res.error).toMatch(error);
    expect(f.records.has("_sites/alice/docs")).toBe(false);
  });

  it("rejects an archive past the account's remaining budget", async () => {
    const f = await archiveFixture();
    f.json("_sites/alice/other", { generation: 1, bytes: LIMITS.free.perUser - 4 });
    const res = await f.error(await f.post(tar([{ name: "a.txt", body: "abc" }, { name: "b.txt", body: "de" }])));
    expect(res).toEqual({ status: 413, error: "account storage exceeded: 4 bytes left (plan free)" });
    expect(f.records.has("_sites/alice/docs")).toBe(false);
  });

  it("answers bad ids, empty bodies and rate limits before touching storage", async () => {
    const f = await archiveFixture();
    expect((await handlePublish(new Request("https://example.com/shares/..", { method: "PUT", body: "x" }), f.env, "..")).status).toBe(400);
    expect(await f.error(await f.post(null))).toEqual({ status: 400, error: "empty body — pipe a tar or a single file" });
    (f.env as { PUBLISH_LIMITER: unknown }).PUBLISH_LIMITER = { limit: async () => ({ success: false }) };
    expect((await f.post(tar([{ name: "a.txt", body: "a" }]))).status).toBe(429);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
});

// Regression: a publish read the share record before streaming and wrote that
// copy back afterwards, so anything committed while the body was in flight was
// silently undone: a rotated key worked again, a takedown was lifted.
describe("changes committed while a publish is in flight", () => {
  async function slowPublish() {
    const f = await fixture();
    f.json("_sites/alice/docs", { generation: 1, public: true, accessKey: "leakedkey", bytes: 2, fileCount: 1, createdAt: 7, lastDeployAt: 7 });
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) { c.enqueue(enc.encode("# sl")); await held; c.enqueue(enc.encode("ow")); c.close(); },
    });
    const publishing = f.request(body, { "content-length": "6" });
    // The publish has read the record and is now waiting on its body.
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledWith("_sites/alice/docs"));
    const owner = (method: string, path: string, json?: unknown) => apexApp.fetch(new Request(`https://example.com${path}`, {
      method, headers: { authorization: "Bearer alice.owner" }, body: json === undefined ? undefined : JSON.stringify(json),
    }), f.env);
    return { ...f, publishing, release, owner };
  }

  it("keeps a key rotation and the privacy it restores", async () => {
    const f = await slowPublish();
    const rotated = await (await f.owner("POST", "/shares/docs/key")).json<{ url: string }>();
    f.release();
    const published = await (await f.publishing).json<{ url: string }>();
    const meta = (await getMeta(f.bucket, "alice", "docs"))!;
    expect(meta.accessKey).not.toBe("leakedkey");
    expect(meta.public).toBe(false);
    expect(published.url).toBe(rotated.url);
    expect(meta).toMatchObject({ generation: 2, createdAt: 7, fileCount: 1, bytes: 6 });
  });

  it("keeps a takedown", async () => {
    const f = await slowPublish();
    const res = await handleAdmin(new Request("https://admin.example.com/admin/api/takedown", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", siteId: "docs" }),
    }), f.env);
    expect(res.status).toBe(200);
    f.release();
    expect((await f.publishing).status).toBe(200);
    expect((await getMeta(f.bucket, "alice", "docs"))!.tombstone).toBe(true);
  });

  it("keeps an upload reserved meanwhile, and its bytes in the account's usage", async () => {
    const f = await slowPublish();
    const env = { ...f.env, R2_ACCOUNT_ID: "acc", R2_BUCKET_NAME: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };
    const res = await apexApp.fetch(new Request("https://example.com/shares/docs/uploads/prepare/demo.mp4", {
      method: "POST", headers: { authorization: "Bearer alice.owner" }, body: JSON.stringify({ bytes: 1000 }),
    }), env);
    expect(res.status).toBe(200);
    f.release();
    await f.publishing;
    expect((await getMeta(f.bucket, "alice", "docs"))!.pending).toEqual({ "demo.mp4": { bytes: 1000, expiresAt: expect.any(Number) } });
    expect(await userUsage(f.bucket, "alice")).toBe(1006);
  });
});

// Regression: files a failed publish had already written stayed in the bucket.
// For a share that never got a record, nothing pointed at them again.
describe("a publish that fails after writing files", () => {
  const broken = () => tar([{ name: "big.bin", body: "x".repeat(4096) }, { name: "index.html", body: "<p>hi" }, { name: "evil", flag: "2" }]);
  const files = (f: { records: Map<string, unknown> }) => [...f.records.keys()].filter(k => k.startsWith("sites/"));

  it("leaves nothing behind when it was an anonymous first publish", async () => {
    const f = await fixture();
    const res = await handlePublish(new Request("https://example.com/shares/leak", { method: "PUT", body: broken() }), f.env, "leak");
    expect(res.status).toBe(400);
    expect(f.put.mock.calls.some(([key]) => String(key).endsWith("/leak/big.bin"))).toBe(true);
    expect(files(f)).toEqual([]);
    expect([...f.records.keys()]).toEqual(["_users/alice"]);
  });

  it("leaves nothing behind when it was the first publish of a new share", async () => {
    const f = await fixture();
    const res = await f.request(broken());
    expect(res.status).toBe(400);
    expect(files(f)).toEqual([]);
    expect(f.records.has("_sites/alice/docs")).toBe(false);
  });

  it("leaves nothing behind when the account runs out of storage midway", async () => {
    const f = await fixture();
    f.json("_sites/alice/other", { generation: 1, bytes: LIMITS.free.perUser - 5000 });
    const res = await f.request(tar([{ name: "a.bin", body: "x".repeat(4096) }, { name: "b.bin", body: "x".repeat(4096) }]));
    expect(res.status).toBe(413);
    expect(files(f)).toEqual([]);
  });

  it("keeps the files of a share that already exists", async () => {
    const f = await fixture();
    f.json("_sites/alice/docs", { generation: 1, public: false, accessKey: "key", bytes: 2, fileCount: 1, createdAt: 0, lastDeployAt: 0 });
    f.records.set("sites/alice/docs/index.html", { body: "hi" });
    expect((await f.request(broken())).status).toBe(400);
    expect(files(f)).toContain("sites/alice/docs/index.html");
    expect((await getMeta(f.bucket, "alice", "docs"))!.generation).toBe(1);
  });

  it("keeps the files if the share came to exist while it was failing", async () => {
    const f = await fixture();
    const originalDelete = f.del.getMockImplementation()!;
    f.get.mockImplementation(async (key: string) => {
      // Another request commits the share between this one's first look and its cleanup.
      if (key === "_sites/alice/docs" && f.put.mock.calls.length) f.json("_sites/alice/docs", { generation: 1, bytes: 1, fileCount: 1 });
      const value = f.records.get(key);
      return value ? { customMetadata: value.customMetadata, body: new Response("").body } as never : null;
    });
    expect((await f.request(broken())).status).toBe(400);
    expect(files(f)).toContain("sites/alice/docs/big.bin");
    f.del.mockImplementation(originalDelete);
  });
});

describe("new anonymous accounts", () => {
  it("are refused once the shared budget is spent, before anything is stored", async () => {
    const f = await fixture();
    (f.env as { SIGNUP_LIMITER: unknown }).SIGNUP_LIMITER = { limit: async () => ({ success: false }) };
    const res = await handlePublish(new Request("https://example.com/shares/x", { method: "PUT", body: "# hi" }), f.env, "x");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many new accounts right now — retry shortly, or send the ownerToken you already have" });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.head).not.toHaveBeenCalled();
  });

  it("do not hold back an account that already has its token", async () => {
    const f = await fixture();
    (f.env as { SIGNUP_LIMITER: unknown }).SIGNUP_LIMITER = { limit: async () => ({ success: false }) };
    expect((await f.request("# Home", { "content-length": "6" })).status).toBe(200);
  });

  it("all draw on one key, whoever asks", async () => {
    const f = await fixture();
    const limit = vi.fn(async () => ({ success: true }));
    (f.env as { SIGNUP_LIMITER: unknown }).SIGNUP_LIMITER = { limit };
    for (const ip of ["203.0.113.7", "2001:db8::1"]) {
      await handlePublish(new Request("https://example.com/shares/x", { method: "PUT", body: "# hi", headers: { "cf-connecting-ip": ip } }), f.env, "x");
    }
    expect(limit.mock.calls).toEqual([[{ key: "anonymous" }], [{ key: "anonymous" }]]);
  });
});

describe("rate limit keys", () => {
  const key = (ip?: string) => clientIp(new Request("https://example.com/", { headers: ip ? { "cf-connecting-ip": ip } : {} }));

  // Regression: an IPv6 customer rotates through 2^64 addresses of one /64, and
  // each was its own limiter key.
  it.each([
    ["2001:db8:1234:5678::1", "2001:db8:1234:5678::/64"],
    ["2001:db8:1234:5678:ffff:ffff:ffff:ffff", "2001:db8:1234:5678::/64"],
    ["2001:0DB8:1234:5678:0:0:0:9", "2001:db8:1234:5678::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:db8:0:0:1::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1:2:3:4", "fe80:0:0:0::/64"],
  ])("puts %s in %s", (ip, network) => {
    expect(key(ip)).toBe(network);
  });

  it("keeps IPv4 addresses whole, mapped ones included", () => {
    expect(key("203.0.113.7")).toBe("203.0.113.7");
    expect(key("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("falls back to the raw value rather than guess at something malformed", () => {
    expect(key("2001:db8:::1")).toBe("2001:db8:::1");
    expect(key("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(key("zzzz::1")).toBe("zzzz::1");
    expect(key()).toBe("unknown");
  });

  it("separates neighbouring networks", () => {
    expect(key("2001:db8:1234:5678::1")).not.toBe(key("2001:db8:1234:5679::1"));
  });
});
