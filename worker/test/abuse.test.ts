import { afterEach, describe, expect, it, vi } from "vitest";
import { apexApp } from "../src/apex";
import { handleAdmin } from "../src/admin";
import { abuseMailto, checkAccessKey } from "../src/auth";
import { handlePublish } from "../src/publish";
import { getMeta, getUser } from "../src/storage";
import { sha256Hex } from "../src/ids";
import { llmsTxt } from "../src/llms";
import type { Env } from "../src/env";
import { testBucket } from "./test-bucket";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const f = testBucket();
  f.json("_users/mallory", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0 });
  f.json("_users/alice", { tokenHash: await sha256Hex("owner"), plan: "free", createdAt: 0 });
  for (const id of ["phish", "kit"]) {
    f.json(`_sites/mallory/${id}`, { generation: 1, public: true, accessKey: "key", bytes: 2, fileCount: 1, createdAt: 0, lastDeployAt: 0 });
    f.records.set(`sites/mallory/${id}/index.html`, { body: "hi" });
  }
  f.json("_sites/alice/docs", { generation: 1, public: false, accessKey: "key", bytes: 2, fileCount: 1, createdAt: 0, lastDeployAt: 0 });
  const owner = (method: string, path: string, body?: BodyInit, user = "mallory") => apexApp.fetch(new Request(`https://example.com${path}`, {
    method, body, headers: { authorization: `Bearer ${user}.owner`, ...(body ? { "content-length": String((body as string).length) } : {}) },
    ...({ duplex: "half" } as object),
  }), f.env);
  const admin = (path: string, body: unknown) => handleAdmin(new Request(`https://admin.example.com/admin/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), f.env);
  vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array> { constructor(_length: number) { super(); } });
  return { ...f, owner, admin };
}

describe("a takedown", () => {
  // Regression: the owner deleted the share, which deleted the takedown with its
  // record, and the next PUT to the same id brought the address back.
  it("cannot be cleared by deleting the share and publishing it again", async () => {
    const f = await fixture();
    expect((await f.admin("takedown", { username: "mallory", siteId: "phish" })).status).toBe(200);
    const del = await f.owner("DELETE", "/shares/phish");
    expect(del.status).toBe(403);
    expect(await del.json()).toEqual({ error: "this share was taken down and cannot be deleted" });
    expect(f.records.has("sites/mallory/phish/index.html")).toBe(true);
    expect((await f.owner("PUT", "/shares/phish", "<!doctype html>again")).status).toBe(200);
    expect((await getMeta(f.bucket, "mallory", "phish"))!.tombstone).toBe(true);
  });

  it("leaves other shares deletable", async () => {
    const f = await fixture();
    expect((await f.owner("DELETE", "/shares/kit")).status).toBe(200);
    expect(await getMeta(f.bucket, "mallory", "kit")).toBeNull();
  });
});

describe("a suspension", () => {
  it("takes down every share of the account and refuses its token everywhere", async () => {
    const f = await fixture();
    const res = await f.admin("suspend", { username: "mallory" });
    expect(await res.json()).toEqual({ ok: true, username: "mallory", suspended: true, takenDown: 2 });
    expect((await getUser(f.bucket, "mallory"))!.suspended).toBe(true);
    for (const id of ["phish", "kit"]) expect((await getMeta(f.bucket, "mallory", id))!.tombstone).toBe(true);

    for (const [method, path, body] of [
      ["GET", "/shares", undefined],
      ["PUT", "/shares/next", "<!doctype html>next"],
      ["PUT", "/shares/phish/files/a.html", "<p>x"],
      ["POST", "/shares/phish/key", undefined],
      ["DELETE", "/shares/kit", undefined],
      ["POST", "/shares/next/uploads/prepare/a.mp4", '{"bytes":5}'],
    ] as const) {
      const refused = await f.owner(method, path, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toEqual({ error: "account suspended" });
    }
    expect(f.records.has("_sites/mallory/next")).toBe(false);
  });

  it("does not touch other accounts", async () => {
    const f = await fixture();
    await f.admin("suspend", { username: "mallory" });
    expect((await f.owner("GET", "/shares/docs", undefined, "alice")).status).toBe(200);
    expect((await getMeta(f.bucket, "alice", "docs"))!.tombstone).toBeUndefined();
  });

  it("says nothing about a suspension to someone without the token", async () => {
    const f = await fixture();
    await f.admin("suspend", { username: "mallory" });
    const res = await apexApp.fetch(new Request("https://example.com/shares", { headers: { authorization: "Bearer mallory.guess" } }), f.env);
    expect(await res.json()).toEqual({ error: "invalid owner token" });
  });

  it("gives the token back when lifted and leaves the shares down", async () => {
    const f = await fixture();
    await f.admin("suspend", { username: "mallory" });
    expect(await (await f.admin("suspend", { username: "mallory", suspended: false })).json()).toMatchObject({ suspended: false, takenDown: 0 });
    expect((await getUser(f.bucket, "mallory"))!.suspended).toBeUndefined();
    expect((await f.owner("GET", "/shares")).status).toBe(200);
    expect((await getMeta(f.bucket, "mallory", "phish"))!.tombstone).toBe(true);
  });

  it("is listed on the account, and refuses bad input", async () => {
    const f = await fixture();
    await f.admin("suspend", { username: "mallory" });
    const list = await (await handleAdmin(new Request("https://admin.example.com/admin/api/users"), f.env)).json<{ users: { username: string; suspended: boolean }[] }>();
    expect(Object.fromEntries(list.users.map(u => [u.username, u.suspended]))).toEqual({ alice: false, mallory: true });
    expect((await f.admin("suspend", { username: "nobody" })).status).toBe(404);
    expect((await f.admin("suspend", { username: "alice", suspended: "yes" })).status).toBe(400);
    expect((await f.admin("suspend", {})).status).toBe(400);
  });
});

describe("the abuse contact", () => {
  const limiter = { limit: async () => ({ success: true }) };
  const gate = { accessKey: "realkey", label: "docs", cookieName: "as_auth_docs", limiterKey: "docs" };
  const prompt = async (env: Partial<Env>) => {
    const res = await checkAccessKey(new Request("https://alice-docs.example.com/"), { APEX_HOST: "example.com", ACCESS_LIMITER: limiter, ...env } as Env, gate);
    return (res as Response).text();
  };

  it("is linked from the key prompt with the share's host in the subject", async () => {
    const html = await prompt({ ABUSE_EMAIL: "abuse@example.com" });
    expect(html).toContain('<a href="mailto:abuse@example.com?subject=Abuse%20report%3A%20alice-docs.example.com">Report abuse</a>');
  });

  it("is absent until the operator sets one", async () => {
    expect(await prompt({})).not.toContain("Report abuse");
    expect(await prompt({ ABUSE_EMAIL: "  " })).not.toContain("Report abuse");
    expect(abuseMailto({ APEX_HOST: "example.com" } as Env)).toBeNull();
  });

  it("is in llms.txt next to the rule it enforces", () => {
    expect(llmsTxt("example.com")).toContain("No phishing, malware or illegal content");
    expect(llmsTxt("example.com")).not.toContain("Report abuse");
    expect(llmsTxt("example.com", "abuse@example.com")).toContain("\n- Report abuse: abuse@example.com\n");
  });
});

// Keep the import honest: publishing straight through handlePublish hits the same gate.
it("refuses a suspended account's publish before reading the body", async () => {
  const f = await fixture();
  await f.admin("suspend", { username: "mallory" });
  const res = await handlePublish(new Request("https://example.com/shares/x", { method: "PUT", body: "# x", headers: { authorization: "Bearer mallory.owner" } }), f.env, "x");
  expect(res.status).toBe(403);
  expect(f.records.has("sites/mallory/x/README.md")).toBe(false);
});
