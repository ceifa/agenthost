import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublish } from "../src/publish";
import { getMeta, getUser, userUsage } from "../src/storage";
import { sha256Hex } from "../src/ids";
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
    { name: "binary garbage", body: () => new Uint8Array([0, 1, 2, 3]), status: 400, error: "unrecognized body — send a tar, a .md/.html document, or name it with ?file=<name>" },
    { name: "garbage labelled as a tarball", body: () => new TextEncoder().encode("not gzip"), headers: { "content-type": "application/gzip" }, status: 400, error: /^bad archive: / },
    { name: "an unsafe ?file= name", body: () => new TextEncoder().encode("x"), query: "file=../x", status: 400, error: "invalid file name: ../x" },
    { name: "a control ?file= name", body: () => new TextEncoder().encode("x"), query: "file=_gen", status: 400, error: "reserved filename: _gen" },
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
