import { describe, expect, it } from "vitest";
import { handleAdmin } from "../src/admin";
import { testBucket } from "./test-bucket";

const user = { tokenHash: "x", plan: "free", createdAt: 0 };

function fixture() {
  const f = testBucket();
  f.json("_users/alice", user);
  const post = (path: string, body: BodyInit) => handleAdmin(new Request(`https://admin.example.com/admin/api/${path}`, {
    method: "POST", body, headers: { "content-type": "application/json" },
  }), f.env);
  return { ...f, post };
}

describe("admin request bodies", () => {
  it.each(["plan", "rename", "takedown"])("answers a malformed %s body with 400, not a crash", async (path) => {
    const f = fixture();
    for (const body of ["{not json", "[]", "null", "{}"]) {
      const res = await f.post(path, body);
      expect(res.status, body).toBe(400);
      expect(await res.json<{ error: string }>()).toHaveProperty("error");
    }
    expect(f.put).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean tombstone", async () => {
    const f = fixture();
    const res = await f.post("takedown", JSON.stringify({ username: "alice", siteId: "docs", tombstone: "yes" }));
    expect(res.status).toBe(400);
  });
});

describe("account list", () => {
  it("flags which accounts on the page have shares", async () => {
    const f = testBucket(3);
    for (const name of ["alice", "bob", "carol", "dan"]) f.json(`_users/${name}`, user);
    // Owners outside the page and a second LIST page around it.
    for (const name of ["aaron", "alice", "amy", "anna", "dave"]) f.records.set(`sites/${name}/docs/index.html`, { body: "x" });
    f.json("_sites/alice/docs", { generation: 1 });
    f.records.set("sites/carol/old/index.html", { body: "x" });
    f.records.set("sites/dan/video/demo.mp4", { body: "x" });
    const flags = async (cursor = "") => {
      const res = await handleAdmin(new Request(`https://admin.example.com/admin/api/users${cursor && `?cursor=${cursor}`}`), f.env);
      return res.json<{ users: { username: string; hasShares: boolean }[]; cursor: string | null }>();
    };
    const first = await flags();
    const second = await flags(first.cursor!);
    expect(Object.fromEntries([...first.users, ...second.users].map((u) => [u.username, u.hasShares]))).toEqual({ alice: true, bob: false, carol: true, dan: true });
  });
});
