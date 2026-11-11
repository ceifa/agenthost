import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runRetentionSweep } from "../src/sweep";
import { testBucket } from "./test-bucket";

const DAY = 86400000;
const user = { tokenHash: "hash", plan: "free" as const, createdAt: 0 };
const meta = { generation: 1, public: false, accessKey: "key", bytes: 10, fileCount: 1, createdAt: 0, lastDeployAt: 0 };
const keys = (f: ReturnType<typeof testBucket>, prefix: string) => [...f.records.keys()].filter(k => k.startsWith(prefix)).sort();

function share(f: ReturnType<typeof testBucket>, username: string, id: string, lastDeployAt = 0) {
  f.json(`_sites/${username}/${id}`, { ...meta, lastDeployAt });
  f.records.set(`sites/${username}/${id}/index.html`, { body: "x" });
}

describe("retention sweep at scale", () => {
  // Regression: two LISTs per account. Every anonymous publish is an account, so
  // a few thousand of them passed the subrequest limit and the run died midway.
  it("reads every account, share and visit in three listings, however many accounts", async () => {
    const f = testBucket();
    const now = 5 * DAY;
    for (let i = 0; i < 300; i++) {
      const name = `user${String(i).padStart(3, "0")}`;
      f.json(`_users/${name}`, user);
      share(f, name, "docs", now);
      f.records.set(`_visits/${name}/docs`, { body: "", uploaded: new Date(now) });
    }
    const result = await runRetentionSweep(f.env, now);
    expect(result).toMatchObject({ checked: 300, deletedCount: 0, complete: true, ops: 3, unowned: 0 });
    expect(f.list).toHaveBeenCalledTimes(3);
  });

  it("joins the listings correctly when one username is the start of another, across pages", async () => {
    const f = testBucket(2);
    const now = 100 * DAY;
    for (const name of ["a1", "ab", "abc", "abcd", "b"]) f.json(`_users/${name}`, user);
    share(f, "a1", "stale");
    share(f, "ab", "stale");
    share(f, "ab", "visited");
    share(f, "abc", "fresh", now);
    share(f, "abcd", "stale");
    share(f, "abcd", "visited");
    share(f, "b", "stale");
    f.records.set("_visits/ab/visited", { body: "", uploaded: new Date(now - DAY) });
    f.records.set("_visits/abcd/visited", { body: "", uploaded: new Date(now - DAY) });
    f.records.set("_visits/abcd/stale", { body: "", uploaded: new Date(now - 20 * DAY) });
    const result = await runRetentionSweep(f.env, now);
    expect(result).toMatchObject({ checked: 7, complete: true });
    expect(keys(f, "_sites/")).toEqual(["_sites/ab/visited", "_sites/abc/fresh", "_sites/abcd/visited"]);
    expect(keys(f, "sites/")).toEqual(["sites/ab/visited/index.html", "sites/abc/fresh/index.html", "sites/abcd/visited/index.html"]);
    // Emptied, old, free accounts go; the ones with a share left stay.
    expect(keys(f, "_users/")).toEqual(["_users/ab", "_users/abc", "_users/abcd"]);
  });

  it("leaves rows whose account is gone or oddly named alone, without losing its place", async () => {
    const f = testBucket(1);
    for (const name of ["a", "ab"]) f.json(`_users/${name}`, { ...user, plan: "paid" });
    f.json("_users/a-b", user);
    share(f, "a", "old");
    share(f, "a-b", "old"); // sorts before "a/" here, after "a" among accounts
    share(f, "aa", "old"); // no account record
    share(f, "ab", "old");
    const result = await runRetentionSweep(f.env, 400 * DAY);
    expect(keys(f, "_sites/")).toEqual(["_sites/a-b/old", "_sites/aa/old"]);
    expect(keys(f, "_users/")).toEqual(["_users/a", "_users/a-b", "_users/ab"]);
    expect(result).toMatchObject({ checked: 2, unowned: 2, complete: true });
  });
});

describe("retention sweep budget", () => {
  function crowded() {
    const f = testBucket();
    for (const name of ["a", "b", "c", "d"]) {
      f.json(`_users/${name}`, user);
      share(f, name, "old");
      share(f, name, "older");
    }
    return f;
  }

  it("stops cleanly when the budget runs out and finishes on later runs", async () => {
    const f = crowded();
    const now = 100 * DAY;
    const first = await runRetentionSweep(f.env, now, { maxOps: 10, maxMs: 60_000 });
    expect(first.complete).toBe(false);
    expect(first.deletedCount).toBeGreaterThan(0);
    expect(keys(f, "_sites/").length).toBeLessThan(8);
    expect(keys(f, "_sites/").length).toBeGreaterThan(0);
    // An account whose shares were not all read is not judged empty.
    for (const key of keys(f, "_sites/")) expect(f.records.has(`_users/${key.split("/")[1]}`)).toBe(true);

    let runs = 1;
    while (!(await runRetentionSweep(f.env, now, { maxOps: 10, maxMs: 60_000 })).complete) {
      if (++runs > 20) throw new Error("the sweep stopped making progress");
    }
    expect(keys(f, "_sites/")).toEqual([]);
    expect(keys(f, "sites/")).toEqual([]);
    expect(keys(f, "_users/")).toEqual([]);
  });

  it("stops when it runs out of time", async () => {
    const f = crowded();
    const result = await runRetentionSweep(f.env, 100 * DAY, { maxOps: 1_000_000, maxMs: 0 });
    expect(result).toMatchObject({ complete: false, deletedCount: 0 });
    expect(keys(f, "_sites/")).toHaveLength(8);
  });
});

describe("cron handler", () => {
  it("fails the invocation when the sweep fails, instead of losing the error", async () => {
    const f = testBucket();
    f.list.mockRejectedValueOnce(new Error("R2 unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(worker.scheduled!({} as ScheduledController, f.env, {} as ExecutionContext)).rejects.toThrow("R2 unavailable");
    expect(error).toHaveBeenCalledWith("retention sweep failed:", expect.any(Error));
    error.mockRestore();
  });

  it("logs what a run did", async () => {
    const f = testBucket();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled!({} as ScheduledController, f.env, {} as ExecutionContext);
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({ checked: 0, complete: true, ops: 1 });
    log.mockRestore();
  });
});
