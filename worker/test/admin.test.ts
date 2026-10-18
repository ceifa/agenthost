import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleAdmin } from "../src/admin";
import { getDomain, getUser } from "../src/storage";
import { testBucket } from "./test-bucket";

afterEach(() => vi.unstubAllGlobals());

const user = { tokenHash: "x", plan: "free", createdAt: 0, legacySiteIds: [] };

function fixture() {
  const f = testBucket();
  f.json("_users/alice", user, true);
  const post = (path: string, body: BodyInit) => handleAdmin(new Request(`https://admin.example.com/admin/api/${path}`, {
    method: "POST", body, headers: { "content-type": "application/json" },
  }), f.env);
  return { ...f, post };
}

describe("admin request bodies", () => {
  it.each(["plan", "rename", "takedown", "domain"])("answers a malformed %s body with 400, not a crash", async (path) => {
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
  it("flags which accounts on the page have sites, flat or legacy", async () => {
    const f = testBucket(3);
    for (const name of ["alice", "bob", "carol"]) f.json(`_users/${name}`, user, true);
    // Owners outside the page and a second LIST page around it.
    for (const name of ["aaron", "alice", "amy", "anna", "dave"]) f.records.set(`sites/${name}/docs/index.html`, { body: "x" });
    f.json("_sites/alice/docs", { generation: 1 }, true);
    f.records.set("sites/carol/old/_meta", { body: "{}" });
    const res = await handleAdmin(new Request("https://admin.example.com/admin/api/users"), f.env);
    const { users } = await res.json<{ users: { username: string; hasSites: boolean }[] }>();
    expect(Object.fromEntries(users.map((u) => [u.username, u.hasSites]))).toEqual({ alice: true, bob: false, carol: true });
  });
});

describe("custom domains", () => {
  it("stores the domain the way the Host router looks it up", async () => {
    const f = fixture();
    f.json("_sites/alice/docs", { generation: 1, public: true, keyHash: null, lastDeployAt: 0 }, true);
    f.records.set("sites/alice/docs/index.html", { body: "<p>home</p>", httpMetadata: { contentType: "text/html" } });
    const res = await f.post("domain", JSON.stringify({ host: " Status.Acme.COM. ", username: "alice", siteId: "docs" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ host: "status.acme.com" });
    expect(await getDomain(f.bucket, "status.acme.com")).toEqual({ username: "alice", siteId: "docs" });
    expect((await getUser(f.bucket, "alice"))!.customDomain).toBe("status.acme.com");

    // A browser asking for STATUS.acme.com reaches the mapped site.
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
    vi.stubGlobal("HTMLRewriter", class { on() { return this; } transform(r: Response) { return r; } });
    const served = await worker.fetch(new Request("https://STATUS.acme.com/", { headers: { host: "STATUS.acme.com" } }), { ...f.env, DEV_MODE: "0" }, { waitUntil() {} } as unknown as ExecutionContext);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<p>home</p>");
  });

  it.each(["not a host", "example.com", "docs.example.com", "-bad.com", "a..b.com", "localhost"])("refuses %s", async (host) => {
    const f = fixture();
    const res = await f.post("domain", JSON.stringify({ host, username: "alice", siteId: "docs" }));
    expect(res.status).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });
});
