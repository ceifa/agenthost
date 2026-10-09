import { describe, expect, it, vi } from "vitest";
import LIVE_JS from "./client/gen/live";
import { LIVE } from "./config";

function browser(coordinate = true) {
  let now = 1_000_000;
  let version = "g1-r4";
  let locked = false;
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const channels: { onmessage?: (event: { data: unknown }) => void }[] = [];
  const fetch = vi.fn(async () => new Response(version, { headers: { etag: `"${version}"` } }));
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const tab = (deployedAt = 0, pageVersion = "g1-r4") => {
    const listeners = new Map<string, (() => void)[]>();
    const on = (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    const document = { currentScript: { dataset: { version: pageVersion, cfg: JSON.stringify(LIVE), deployedAt: String(deployedAt) } }, visibilityState: "visible", activeElement: null as { tagName: string } | null, querySelector: () => null, addEventListener: on };
    const reload = vi.fn();
    const globals = {
      document, location: { reload }, fetch,
      Date: { now: () => now }, Math: { random: () => 0 },
      addEventListener: on,
      clearTimeout: (id: number) => timers.delete(id),
      window: { getSelection: () => "", setTimeout: (fn: () => void, ms: number) => {
        const id = ++timerId;
        timers.set(id, { at: now + ms, fn });
        return id;
      } },
      navigator: { locks: coordinate ? { request: async (_name: string, _opts: unknown, fn: (lock: object | null) => Promise<void>) => {
        if (locked) return fn(null);
        locked = true;
        try { await fn({}); } finally { locked = false; }
      } } : undefined },
      BroadcastChannel: class {
        onmessage?: (event: { data: unknown }) => void;
        constructor() { channels.push(this); }
        postMessage(data: unknown) { for (const channel of channels) if (channel !== this) channel.onmessage?.({ data }); }
        close() { channels.splice(channels.indexOf(this), 1); }
      },
    };
    // Run the shipped browser bundle against separate tab globals.
    new Function(...Object.keys(globals), LIVE_JS)(...Object.values(globals));
    return { document, reload, event: (event: string) => { for (const fn of listeners.get(event) ?? []) fn(); } };
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { tab, advance, fetch, flush, change: (next: string) => { version = next; }, now: () => now };
}

describe("live polling coordination", () => {
  it("shares one poll across three visible tabs and transfers leadership when hidden", async () => {
    const b = browser();
    const leader = b.tab();
    const follower = b.tab();
    const other = b.tab();
    await b.advance(60_000);
    expect(b.fetch).toHaveBeenCalledOnce();
    leader.document.visibilityState = "hidden";
    leader.event("visibilitychange");
    await b.flush();
    await b.advance(5_000);
    expect(b.fetch).toHaveBeenCalledTimes(2);
    b.change("g2-r4");
    await b.advance(60_000);
    expect(leader.reload).not.toHaveBeenCalled();
    expect(follower.reload).toHaveBeenCalled();
    expect(other.reload).toHaveBeenCalled();
  });

  it("uses fast polling only for recently published content", async () => {
    const old = browser(false);
    old.tab();
    await old.advance(15_000);
    expect(old.fetch).not.toHaveBeenCalled();
    await old.advance(45_000);
    expect(old.fetch).toHaveBeenCalledOnce();
    const recent = browser(false);
    recent.tab(recent.now());
    await recent.advance(15_000);
    expect(recent.fetch).toHaveBeenCalledOnce();
  });

  it("keeps independent polling when coordination is unavailable", async () => {
    const b = browser(false);
    b.tab(); b.tab();
    await b.advance(60_000);
    expect(b.fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores older probe generations and delays a shared reload while typing", async () => {
    const b = browser();
    const first = b.tab();
    const newer = b.tab(0, "g2-r4");
    const busy = b.tab();
    busy.document.activeElement = { tagName: "INPUT" };
    await b.advance(60_000);
    expect(newer.reload).not.toHaveBeenCalled();
    b.change("g2-r4");
    await b.advance(60_000);
    expect(first.reload).toHaveBeenCalled();
    expect(busy.reload).not.toHaveBeenCalled();
    busy.document.activeElement = null;
    await b.advance(5_000);
    expect(busy.reload).toHaveBeenCalled();
  });
});
