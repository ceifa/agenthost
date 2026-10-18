import { describe, expect, it, vi } from "vitest";
import { assetUsage, getMeta, getUser, putMeta, putUser, listUsersPage, userUsage, mapBounded } from "../src/storage";
import { handleAdmin } from "../src/admin";
import { runRetentionSweep } from "../src/sweep";
import { testBucket } from "./test-bucket";

const user = { tokenHash: "hash", plan: "free" as const, createdAt: 0 };
const meta = { generation: 1, public: false, keyHash: "hash", bytes: 10, fileCount: 1, createdAt: 0, lastDeployAt: 0 };
const asset = (username: string, id: string, status = "ready") => ({ id, username, status, bytes: 20, objectKey: `assets/${username}/${id}/blob`, createdAt: 0, lastDeployAt: 0 });

describe("compact metadata", () => {
  it("accounts for 100 sites and 100 assets in two LISTs with no metadata GETs", async () => {
    const f = testBucket();
    for (let i = 0; i < 100; i++) {
      f.json(`_sites/u/s${i}`, meta);
      f.json(`_assets/u/a${i}/_meta`, asset("u", `a${i}`));
    }
    expect(await userUsage(f.bucket, "u")).toBe(1000);
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
    expect(await userUsage(f.bucket, "u")).toBe(10);
    expect((await listUsersPage(f.bucket)).items[0]!.user).toEqual(user);
    expect(f.get).not.toHaveBeenCalled();
    expect(await getMeta(f.bucket, "u", "docs")).toEqual(meta);
    await putMeta(f.bucket, "u", "docs", { ...meta, tombstone: true });
    expect((await getMeta(f.bucket, "u", "docs"))!.tombstone).toBe(true);
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

  it("preserves inline metadata and asset payload keys during admin rename", async () => {
    const f = testBucket(1);
    f.json("_users/alice", user);
    f.json("_sites/alice/docs", meta);
    f.records.set("sites/alice/docs/index.html", { body: "<body>Home</body>" });
    f.json("_assets/alice/a/_meta", asset("alice", "a"));
    const res = await handleAdmin(new Request("https://admin.example.com/admin/api/rename", { method: "POST", body: JSON.stringify({ from: "alice", to: "bob" }), headers: { "content-type": "application/json" } }), f.env);
    expect(res.status).toBe(200);
    expect(await getMeta(f.bucket, "bob", "docs")).toEqual(meta);
    expect(await getUser(f.bucket, "bob")).toEqual(user);
    expect(JSON.parse(f.records.get("_assets/bob/a/_meta")!.customMetadata!.json!).objectKey).toBe("assets/alice/a/blob");
    expect([...f.records.keys()].some(k => k.startsWith("_sites/alice/") || k.startsWith("sites/alice/"))).toBe(false);
  });

  it("sweeps multiple pages with correct paid/pending/orphan policies and no profile GETs", async () => {
    const f = testBucket(1);
    f.json("_users/b", user);
    f.json("_users/d", { ...user, plan: "paid" });
    for (const username of ["b", "d"]) {
      f.json(`_sites/${username}/old`, meta);
      f.records.set(`sites/${username}/old/index.html`, { body: "old" });
      f.json(`_assets/${username}/ready/_meta`, asset(username, "ready"));
      f.json(`_assets/${username}/pending/_meta`, asset(username, "pending", "pending"));
    }
    f.json("_assets/a/orphan/_meta", asset("a", "orphan"));
    f.json("_assets/z/orphan/_meta", asset("z", "orphan"));
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
    f.json("_users/upload", user);
    f.json("_assets/upload/fresh/_meta", { ...asset("upload", "fresh"), lastDeployAt: now });
    await runRetentionSweep(f.env, now);
    expect([...f.records.keys()].filter(k => k.startsWith("_users/")).sort()).toEqual(["_users/paid", "_users/site", "_users/upload", "_users/young"]);
  });
});
