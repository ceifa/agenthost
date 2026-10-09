import { describe, expect, it, vi } from "vitest";
import { assetUsage, getMeta, getGen, getUser, putMeta, putUser, listSitesPage, listUsersPage, userUsage, mapBounded } from "./storage";
import { handleAdmin } from "./admin";
import { runRetentionSweep } from "./sweep";
import { testBucket } from "./test-bucket";

const user = { tokenHash: "hash", plan: "free" as const, createdAt: 0, legacySiteIds: [] as string[] };
const meta = { generation: 1, public: false, keyHash: "hash", bytes: 10, fileCount: 1, createdAt: 0, lastDeployAt: 0 };
const asset = (username: string, id: string, status = "ready") => ({ id, username, status, bytes: 20, objectKey: `assets/${username}/${id}/blob`, createdAt: 0, lastDeployAt: 0 });

describe("compact metadata and compatibility", () => {
  it("accounts for 100 sites and 100 assets in two LISTs with no metadata GETs", async () => {
    const f = testBucket();
    for (let i = 0; i < 100; i++) {
      f.json(`_sites/u/s${i}`, meta, true);
      f.json(`_assets/u/a${i}/_meta`, asset("u", `a${i}`), true);
    }
    expect(await userUsage(f.bucket, "u", undefined, user)).toBe(1000);
    expect(await assetUsage(f.bucket, "u")).toBe(2000);
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.get).not.toHaveBeenCalled();
  });
  it("stores JSON once, lists it without GETs, and reads current access policy", async () => {
    const f = testBucket();
    await putUser(f.bucket, "u", user);
    await putMeta(f.bucket, "u", "docs", meta);
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(f.records.get("_sites/u/docs")!.body).toBe("");
    vi.clearAllMocks();
    expect(await userUsage(f.bucket, "u", undefined, user)).toBe(10);
    expect((await listUsersPage(f.bucket)).items[0]!.user).toEqual(user);
    expect(f.get).not.toHaveBeenCalled();
    expect(await getMeta(f.bucket, "u", "docs")).toEqual(meta);
    await putMeta(f.bucket, "u", "docs", { ...meta, tombstone: true });
    expect((await getMeta(f.bucket, "u", "docs"))!.tombstone).toBe(true);
    expect(await getGen(f.bucket, "u", "docs")).toBe(1);
  });

  it("falls back to object bodies for large records and legacy metadata", async () => {
    const f = testBucket();
    const large = { ...user, legacySiteIds: Array.from({ length: 1000 }, (_, i) => `site-${i}`) };
    await putUser(f.bucket, "u", large);
    expect(f.records.get("_users/u")!.body.length).toBeGreaterThan(6000);
    expect((await listUsersPage(f.bucket)).items[0]!.user).toEqual(large);
    expect(f.get).toHaveBeenCalledWith("_users/u");
    f.json("sites/u/old/_meta", { ...meta, generation: undefined });
    f.records.set("sites/u/old/_gen", { body: "7" });
    const old = await getMeta(f.bucket, "u", "old");
    expect(old!.generation).toBeUndefined();
    expect(await getGen(f.bucket, "u", "old")).toBe(7);
    await putMeta(f.bucket, "u", "old", { ...old!, public: true });
    expect(f.records.has("_sites/u/old")).toBe(false);
  });

  it("enumerates mixed inventories across cursors and charges each site once", async () => {
    const f = testBucket(1);
    const mixed = { ...user, legacySiteIds: ["old", "gone"] };
    f.json("_sites/u/a", meta, true);
    f.json("_sites/u/b", { ...meta, bytes: 11 }, true);
    f.json("sites/u/old/_meta", { ...meta, generation: undefined, bytes: 12 });
    f.json("_assets/u/a/_meta", asset("u", "a"), true);
    f.json("_assets/u/b/_meta", asset("u", "b"));
    const found = [];
    let cursor: string | undefined;
    do {
      const page = await listSitesPage(f.bucket, "u", mixed, cursor);
      found.push(...page.items.map(r => r.siteId));
      cursor = page.cursor;
    } while (cursor);
    expect(found).toEqual(["a", "b", "old"]);
    expect(await userUsage(f.bucket, "u", "a", mixed)).toBe(23);
    expect(await assetUsage(f.bucket, "u")).toBe(40);
    for (const bad of [btoa("null"), btoa('{"phase":"bad","offset":0}'), btoa('{"phase":"flat","offset":-1}')]) {
      await expect(listSitesPage(f.bucket, "u", mixed, bad)).rejects.toThrow("invalid cursor");
    }
  });

  it("discovers committed flat records even if legacy catalog migration was interrupted", async () => {
    const f = testBucket();
    f.json("_sites/u/docs", meta, true);
    f.records.set("sites/u/docs/index.html", { body: "<body>Home</body>" });
    const legacy = { ...user, legacySiteIds: undefined };
    expect(await userUsage(f.bucket, "u", undefined, legacy)).toBe(10);
  });

  it("bounds concurrent legacy reads", async () => {
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
    f.json("_users/a", user, true);
    f.json("_users/b", user, true);
    const request = (query = "") => handleAdmin(new Request("https://admin.example.com/admin/api/users" + query), f.env);
    const first = await (await request()).json<{ users: { username: string }[]; cursor: string }>();
    expect(first.users.map(u => u.username)).toEqual(["a"]);
    const second = await (await request("?cursor=" + encodeURIComponent(first.cursor))).json<{ users: { username: string }[]; cursor: null }>();
    expect(second.users.map(u => u.username)).toEqual(["b"]);
    expect(second.cursor).toBeNull();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("preserves inline metadata and asset payload keys during admin rename", async () => {
    const f = testBucket(1);
    f.json("_users/alice", user, true);
    f.json("_sites/alice/docs", meta, true);
    f.records.set("sites/alice/docs/index.html", { body: "<body>Home</body>" });
    f.json("_assets/alice/a/_meta", asset("alice", "a"), true);
    const res = await handleAdmin(new Request("https://admin.example.com/admin/api/rename", { method: "POST", body: JSON.stringify({ from: "alice", to: "bob" }), headers: { "content-type": "application/json" } }), f.env);
    expect(res.status).toBe(200);
    expect(await getMeta(f.bucket, "bob", "docs")).toEqual(meta);
    expect((await getUser(f.bucket, "bob"))!.legacySiteIds).toEqual([]);
    expect(JSON.parse(f.records.get("_assets/bob/a/_meta")!.customMetadata!.json!).objectKey).toBe("assets/alice/a/blob");
    expect([...f.records.keys()].some(k => k.startsWith("_sites/alice/") || k.startsWith("sites/alice/"))).toBe(false);
  });

  it("sweeps multiple pages with correct paid/pending/orphan policies and no profile GETs", async () => {
    const f = testBucket(1);
    f.json("_users/b", user, true);
    f.json("_users/d", { ...user, plan: "paid" }, true);
    for (const username of ["b", "d"]) {
      f.json(`_sites/${username}/old`, meta, true);
      f.records.set(`sites/${username}/old/index.html`, { body: "old" });
      f.json(`_assets/${username}/ready/_meta`, asset(username, "ready"), true);
      f.json(`_assets/${username}/pending/_meta`, asset(username, "pending", "pending"), true);
    }
    f.json("_assets/a/orphan/_meta", asset("a", "orphan"), true);
    f.json("_assets/z/orphan/_meta", asset("z", "orphan"), true);
    const result = await runRetentionSweep(f.env, 16 * 86400000);
    expect(result.checked).toBe(8);
    expect(result.deletedCount).toBe(6);
    expect(f.records.has("_sites/b/old")).toBe(false);
    expect(f.records.has("_sites/d/old")).toBe(true);
    expect(f.records.has("_assets/d/ready/_meta")).toBe(true);
    expect(f.records.has("_assets/d/pending/_meta")).toBe(false);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
});
