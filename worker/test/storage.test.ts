import { describe, expect, it, vi } from "vitest";
import { getMeta, getUser, putUser, listUsersPage, readMeta, updateMeta, userUsage, mapBounded, RecordBusyError, NO_RECORD } from "../src/storage";
import { handleAdmin } from "../src/admin";
import { runRetentionSweep } from "../src/sweep";
import { testBucket } from "./test-bucket";

const user = { tokenHash: "hash", plan: "free" as const, createdAt: 0 };
const meta = { generation: 1, public: false, accessKey: "key", bytes: 10, fileCount: 1, createdAt: 0, lastDeployAt: 0 };

describe("compact metadata", () => {
  it("accounts for 100 shares and their pending uploads in one LIST with no metadata GETs", async () => {
    const f = testBucket();
    for (let i = 0; i < 100; i++) f.json(`_sites/u/s${i}`, { ...meta, pending: { "big.bin": { bytes: 20, expiresAt: 0 } } });
    expect(await userUsage(f.bucket, "u")).toBe(3000);
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.get).not.toHaveBeenCalled();
  });
  it("stores JSON once, lists it without GETs, and reads current access policy", async () => {
    const f = testBucket();
    await putUser(f.bucket, "u", user);
    await updateMeta(f.bucket, "u", "docs", () => meta);
    expect(f.put).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
    expect(await userUsage(f.bucket, "u")).toBe(10);
    expect((await listUsersPage(f.bucket)).items[0]!.user).toEqual(user);
    expect(f.get).not.toHaveBeenCalled();
    expect(await getMeta(f.bucket, "u", "docs")).toEqual(meta);
    await updateMeta(f.bucket, "u", "docs", current => ({ ...current!, tombstone: true }));
    expect((await getMeta(f.bucket, "u", "docs"))!.tombstone).toBe(true);
  });

  // R2's etag follows the body, and a record's JSON is in its metadata: without
  // a stamp every version of a record would carry the same etag.
  it("stamps each write so two versions of a record never share an etag", async () => {
    const f = testBucket();
    await updateMeta(f.bucket, "u", "docs", () => meta);
    const first = f.records.get("_sites/u/docs")!.body;
    await updateMeta(f.bucket, "u", "docs", current => current);
    expect(first).not.toBe("");
    expect(f.records.get("_sites/u/docs")!.body).not.toBe(first);
  });
});

describe("share record updates", () => {
  it("re-applies a change to the record another writer committed in between", async () => {
    const f = testBucket();
    f.json("_sites/u/docs", { ...meta, generation: 1 });
    let raced = false;
    const seen: number[] = [];
    const result = await updateMeta(f.bucket, "u", "docs", async current => {
      seen.push(current!.generation);
      if (!raced) {
        raced = true;
        await updateMeta(f.bucket, "u", "docs", other => ({ ...other!, generation: 5, tombstone: true }));
      }
      return { ...current!, generation: current!.generation + 1 };
    });
    expect(seen).toEqual([1, 5]);
    expect(result).toMatchObject({ generation: 6, tombstone: true });
    expect(await getMeta(f.bucket, "u", "docs")).toMatchObject({ generation: 6, tombstone: true });
  });

  it("writes against a version the caller already read, without reading it again", async () => {
    const f = testBucket();
    f.json("_sites/u/docs", meta);
    const seen = await readMeta(f.bucket, "u", "docs");
    vi.clearAllMocks();
    expect(await updateMeta(f.bucket, "u", "docs", current => ({ ...current!, generation: 2 }), seen)).toMatchObject({ generation: 2 });
    expect(f.head).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    // The same for a record known not to exist.
    expect(await updateMeta(f.bucket, "u", "fresh", () => meta, NO_RECORD)).toEqual(meta);
    expect(f.head).not.toHaveBeenCalled();
  });

  it("starts over from a fresh read when that version is no longer current", async () => {
    const f = testBucket();
    f.json("_sites/u/docs", meta);
    const seen = await readMeta(f.bucket, "u", "docs");
    await updateMeta(f.bucket, "u", "docs", current => ({ ...current!, generation: 5, tombstone: true }));
    const applied: number[] = [];
    const result = await updateMeta(f.bucket, "u", "docs", current => {
      applied.push(current!.generation);
      return { ...current!, generation: current!.generation + 1 };
    }, seen);
    expect(applied).toEqual([1, 5]);
    expect(result).toMatchObject({ generation: 6, tombstone: true });
    // A record created since is not overwritten either.
    await updateMeta(f.bucket, "u", "new", () => ({ ...meta, accessKey: "first" }));
    expect(await updateMeta(f.bucket, "u", "new", current => ({ ...meta, ...current, generation: 2 }), NO_RECORD)).toMatchObject({ accessKey: "first", generation: 2 });
  });

  it("decides to leave a record alone only on a fresh read", async () => {
    const f = testBucket();
    const seen = await readMeta(f.bucket, "u", "docs");
    await updateMeta(f.bucket, "u", "docs", () => meta);
    expect(await updateMeta(f.bucket, "u", "docs", current => current && { ...current, public: true }, seen)).toMatchObject({ public: true });
  });

  it("does not let two creators of the same record both win", async () => {
    const f = testBucket();
    let raced = false;
    await updateMeta(f.bucket, "u", "docs", async current => {
      if (!raced) {
        raced = true;
        await updateMeta(f.bucket, "u", "docs", () => ({ ...meta, accessKey: "first" }));
      }
      return { ...meta, ...current, generation: (current?.generation ?? 0) + 1 };
    });
    expect(await getMeta(f.bucket, "u", "docs")).toMatchObject({ accessKey: "first", generation: 2 });
  });

  it("updates a record written before bodies were stamped", async () => {
    const f = testBucket();
    f.json("_sites/u/old", meta);
    expect(f.records.get("_sites/u/old")!.body).toBe("");
    expect(await updateMeta(f.bucket, "u", "old", current => ({ ...current!, public: true }))).toMatchObject({ public: true });
  });

  it("leaves the record alone when the change declines, and reports a missing one as null", async () => {
    const f = testBucket();
    f.json("_sites/u/docs", meta);
    expect(await updateMeta(f.bucket, "u", "docs", () => null)).toBeNull();
    expect(await updateMeta(f.bucket, "u", "gone", current => current && { ...current, public: true })).toBeNull();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("gives up with RecordBusyError when the record changes under every attempt", async () => {
    const f = testBucket();
    f.json("_sites/u/docs", { ...meta, generation: 1 });
    let n = 0;
    await expect(updateMeta(f.bucket, "u", "docs", async current => {
      f.json("_sites/u/docs", { ...meta, generation: 100 + n });
      f.records.get("_sites/u/docs")!.body = `v${n++}`;
      return { ...current!, public: true };
    })).rejects.toBeInstanceOf(RecordBusyError);
    expect(n).toBe(6);
  });

  it("bounds concurrent reads", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapBounded(Array.from({ length: 30 }, (_, i) => i), async i => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return i * 2;
    });
    expect(peak).toBe(3);
    expect(result).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
  });
});

describe("admin and retention", () => {
  it("returns paginated admin inventory without metadata GET fanout", async () => {
    const f = testBucket(1);
    f.json("_users/a", user);
    f.json("_users/b", user);
    const request = (query = "") => handleAdmin(new Request("https://admin.example.com/admin/api/users" + query), f.env);
    const first = await (await request()).json<{ users: { username: string }[]; cursor: string }>();
    expect(first.users.map(u => u.username)).toEqual(["a"]);
    const second = await (await request("?cursor=" + encodeURIComponent(first.cursor))).json<{ users: { username: string }[]; cursor: null }>();
    expect(second.users.map(u => u.username)).toEqual(["b"]);
    expect(second.cursor).toBeNull();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("moves inline metadata and files during admin rename", async () => {
    const f = testBucket(1);
    f.json("_users/alice", user);
    f.json("_sites/alice/docs", meta);
    f.records.set("sites/alice/docs/index.html", { body: "<body>Home</body>" });
    f.records.set("_visits/alice/docs", { body: "" });
    const res = await handleAdmin(new Request("https://admin.example.com/admin/api/rename", { method: "POST", body: JSON.stringify({ from: "alice", to: "bob" }), headers: { "content-type": "application/json" } }), f.env);
    expect(res.status).toBe(200);
    expect(await getMeta(f.bucket, "bob", "docs")).toEqual(meta);
    expect(await getUser(f.bucket, "bob")).toEqual(user);
    expect(f.records.get("sites/bob/docs/index.html")!.body).toBe("<body>Home</body>");
    expect(f.records.has("_visits/bob/docs")).toBe(true);
    expect([...f.records.keys()].some(k => k.includes("/alice/"))).toBe(false);
  });

  it("sweeps multiple pages with correct free/paid policies and no profile GETs", async () => {
    const f = testBucket(1);
    f.json("_users/b", user);
    f.json("_users/d", { ...user, plan: "paid" });
    for (const username of ["b", "d"]) {
      f.json(`_sites/${username}/old`, meta);
      f.records.set(`sites/${username}/old/index.html`, { body: "old" });
    }
    const result = await runRetentionSweep(f.env, 16 * 86400000);
    expect(result.checked).toBe(2);
    expect(result.deletedCount).toBe(1);
    expect(f.records.has("_sites/b/old")).toBe(false);
    expect(f.records.has("sites/b/old/index.html")).toBe(false);
    expect(f.records.has("_sites/d/old")).toBe(true);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("keeps a paid share for a year after its last change, then deletes it", async () => {
    const f = testBucket();
    f.json("_users/d", { ...user, plan: "paid" });
    f.json("_sites/d/old", meta);
    f.records.set("sites/d/old/index.html", { body: "old" });
    await runRetentionSweep(f.env, 365 * 86400000);
    expect(f.records.has("_sites/d/old")).toBe(true);
    await runRetentionSweep(f.env, 366 * 86400000);
    expect(f.records.has("_sites/d/old")).toBe(false);
    expect(f.records.has("sites/d/old/index.html")).toBe(false);
    expect(f.records.has("_users/d")).toBe(true);
  });

  it("keeps a free share visited within the window, however old its last publish", async () => {
    const f = testBucket(1);
    const day = 86400000, now = 100 * day;
    f.json("_users/u", user);
    for (const id of ["read", "stale", "never"]) {
      f.json(`_sites/u/${id}`, meta);
      f.records.set(`sites/u/${id}/index.html`, { body: "x" });
    }
    f.records.set("_visits/u/read", { body: "", uploaded: new Date(now - 3 * day) });
    f.records.set("_visits/u/stale", { body: "", uploaded: new Date(now - 20 * day) });
    await runRetentionSweep(f.env, now);
    expect([...f.records.keys()].filter(k => k.startsWith("_sites/"))).toEqual(["_sites/u/read"]);
    // A deleted share takes its visit record with it.
    expect([...f.records.keys()].filter(k => k.startsWith("_visits/"))).toEqual(["_visits/u/read"]);
  });

  it("deletes free accounts left empty after 90 days and keeps paid, young or non-empty ones", async () => {
    const f = testBucket(1);
    const now = 91 * 86400000;
    f.json("_users/empty", user);
    f.json("_users/emptied", user);
    f.json("_sites/emptied/old", meta);
    f.json("_users/young", { ...user, createdAt: now - 89 * 86400000 });
    f.json("_users/paid", { ...user, plan: "paid" });
    f.json("_users/site", user);
    f.json("_sites/site/fresh", { ...meta, lastDeployAt: now });
    await runRetentionSweep(f.env, now);
    expect([...f.records.keys()].filter(k => k.startsWith("_users/")).sort()).toEqual(["_users/paid", "_users/site", "_users/young"]);
  });
});
