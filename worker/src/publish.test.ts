import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublish } from "./publish";
import { getMeta, getUser, userUsage } from "./storage";
import { sha256Hex } from "./ids";
import { LIMITS } from "./config";
import { testBucket } from "./test-bucket";

afterEach(() => vi.unstubAllGlobals());

async function fixture(legacy = false) {
  const f = testBucket();
  f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0, ...(legacy ? {} : { legacySiteIds: [] }) }, !legacy);
  const request = (body: BodyInit, headers: Record<string, string> = {}) => handlePublish(new Request("https://example.com/publish?username=alice&id=docs", {
    method: "POST", body, headers: { authorization: "Bearer owner", "content-type": "text/markdown", ...headers },
    ...({ duplex: "half" } as object),
  }), f.env);
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
    f.json("_sites/alice/other", { generation: 1, bytes: LIMITS.free.perUser - 4 }, true);
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

  it("migrates legacy sites on publish without extra control PUTs or clearing a takedown", async () => {
    const f = await fixture(true);
    const old = { public: true, keyHash: "key", tombstone: true, createdAt: 0, lastDeployAt: 0, bytes: 5, fileCount: 1 };
    f.json("sites/alice/docs/_meta", old);
    f.records.set("sites/alice/docs/_gen", { body: "7" });
    f.records.set("sites/alice/docs/README.md", { body: "# Old" });
    f.json("sites/alice/other/_meta", old);
    const res = await f.request("# Home", { "content-length": "6" });
    expect(res.status).toBe(200);
    const meta = (await getMeta(f.bucket, "alice", "docs"))!;
    expect(meta.generation).toBe(8);
    expect(meta.tombstone).toBe(true);
    const account = (await getUser(f.bucket, "alice"))!;
    expect(account.legacySiteIds).toEqual(["other"]);
    expect(await userUsage(f.bucket, "alice", undefined, account)).toBe(11);
    expect(f.put.mock.calls.map(([key]) => key)).toEqual(["sites/alice/docs/README.md", "_sites/alice/docs", "_users/alice"]);
    expect(f.records.has("sites/alice/docs/_meta")).toBe(false);
    expect(f.records.has("sites/alice/docs/_gen")).toBe(false);
  });

  it("recovers inventory and generation when a migration catalog PUT fails", async () => {
    const f = await fixture(true);
    f.json("sites/alice/docs/_meta", { public: true, keyHash: "key", createdAt: 0, lastDeployAt: 0, bytes: 5, fileCount: 1 });
    f.records.set("sites/alice/docs/_gen", { body: "7" });
    const put = f.put.getMockImplementation()!;
    f.put.mockImplementationOnce(put).mockImplementationOnce(put).mockRejectedValueOnce(new Error("catalog failed"));
    await expect(f.request("# Home", { "content-length": "6" })).rejects.toThrow("catalog failed");
    const legacy = (await getUser(f.bucket, "alice"))!;
    expect(legacy.legacySiteIds).toBeUndefined();
    expect(await userUsage(f.bucket, "alice", undefined, legacy)).toBe(6);
    expect((await getMeta(f.bucket, "alice", "docs"))!.generation).toBe(8);
    expect((await f.request("# Next", { "content-length": "6" })).status).toBe(200);
    expect((await getMeta(f.bucket, "alice", "docs"))!.generation).toBe(9);
    expect((await getUser(f.bucket, "alice"))!.legacySiteIds).toEqual([]);
  });
});
