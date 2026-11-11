import { describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../src/admin";
import { testBucket } from "./test-bucket";

// The Access JWT is taken as valid here: these tests are about what a request
// that carries the operator's cookie may still not do.
vi.mock("../src/auth", async (original) => ({
  ...(await original<typeof import("../src/auth")>()),
  verifyAdmin: vi.fn(async () => true),
}));

const ADMIN = "https://admin.example.com";

function fixture() {
  const f = testBucket();
  const env = { ...f.env, DEV_MODE: undefined, ASSETS: { fetch: async () => new Response("<html>") } } as unknown as typeof f.env;
  f.json("_users/mallory", { tokenHash: "x", plan: "free", createdAt: 0 });
  f.json("_sites/mallory/phish", { generation: 1, public: true, bytes: 1, fileCount: 1, createdAt: 0, lastDeployAt: 0, tombstone: true });
  const send = (path: string, body: unknown, headers: Record<string, string>) =>
    handleAdmin(new Request(`${ADMIN}/admin/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
  const plan = () => JSON.parse(f.records.get("_users/mallory")!.customMetadata!.json!).plan;
  return { ...f, env, send, plan };
}

describe("admin writes", () => {
  it("accepts the console's own JSON post", async () => {
    const f = fixture();
    const res = await f.send("plan", { username: "mallory", plan: "paid" }, { origin: ADMIN, "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(f.plan()).toBe("paid");
  });

  // Regression: a hosted share is same-site with the admin, so its page could post
  // here with the operator's Access cookie attached. text/plain needs no preflight.
  it.each([
    ["a share's text/plain fetch", { origin: "https://mallory-phish.example.com", "content-type": "text/plain" }],
    ["a share's form post", { origin: "https://mallory-phish.example.com", "content-type": "application/x-www-form-urlencoded" }],
    ["a share claiming JSON", { origin: "https://mallory-phish.example.com", "content-type": "application/json" }],
    ["the admin origin with a form type", { origin: ADMIN, "content-type": "text/plain" }],
    ["a look-alike origin", { origin: "https://admin.example.com.evil.test", "content-type": "application/json" }],
    ["no Origin at all", { "content-type": "application/json" }],
    ["an opaque origin", { origin: "null", "content-type": "application/json" }],
  ])("refuses %s", async (_, headers) => {
    const f = fixture();
    const res = await f.send("plan", { username: "mallory", plan: "paid" }, headers as Record<string, string>);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross-origin request refused" });
    expect(f.plan()).toBe("free");
    expect(f.put).not.toHaveBeenCalled();
  });

  it("refuses to lift a takedown for a share's page", async () => {
    const f = fixture();
    const res = await f.send("takedown", { username: "mallory", siteId: "phish", tombstone: false }, { origin: "https://mallory-phish.example.com", "content-type": "text/plain" });
    expect(res.status).toBe(403);
    expect(JSON.parse(f.records.get("_sites/mallory/phish")!.customMetadata!.json!).tombstone).toBe(true);
  });

  it("accepts a charset on the JSON type", async () => {
    const f = fixture();
    const res = await f.send("plan", { username: "mallory", plan: "paid" }, { origin: ADMIN, "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });
});

describe("admin responses", () => {
  it.each([
    ["an API answer", "/admin/api/users"],
    ["the console itself", "/"],
  ])("forbid framing and cross-origin embedding on %s", async (_, path) => {
    const f = fixture();
    const res = await handleAdmin(new Request(ADMIN + path), f.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("still answers reads without an Origin", async () => {
    const f = fixture();
    const res = await handleAdmin(new Request(`${ADMIN}/admin/api/sites?username=mallory`), f.env);
    expect(res.status).toBe(200);
  });
});
