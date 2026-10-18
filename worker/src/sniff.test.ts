import { describe, expect, it, vi } from "vitest";
import { ABANDON_LIMITS, peek } from "./sniff";

// A request body: `chunks` arrive, then the body ends, or stays open if `open`.
function body(chunks: Uint8Array[], open = false) {
  const cancel = vi.fn();
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[pulled];
      if (next) {
        pulled++;
        c.enqueue(next);
      } else if (!open) c.close();
      else return new Promise(() => {}); // the client stopped sending, connection still open
    },
    cancel,
  }, { highWaterMark: 0 });
  return { stream, cancel, pulled: () => pulled };
}

const kb = (n: number) => new Uint8Array(n * 1024);

describe("abandoning a peeked body", () => {
  it.each(["replay stream", "peek handle"])("drains what already arrived before letting go (%s)", async (via) => {
    const b = body([kb(1), kb(4), kb(4), kb(1)]);
    const peeked = await peek(b.stream);
    await (via === "replay stream" ? peeked.stream.cancel("rejected") : peeked.cancel("rejected"));
    expect(b.pulled()).toBe(4);
    expect(b.cancel).not.toHaveBeenCalled();
  });

  it("cuts off a body that stops arriving", async () => {
    const b = body([kb(1), kb(1)], true);
    const peeked = await peek(b.stream);
    const started = Date.now();
    await peeked.cancel("rejected");
    expect(Date.now() - started).toBeGreaterThanOrEqual(ABANDON_LIMITS.ms - 20);
    expect(b.cancel).toHaveBeenCalledWith("rejected");
  });

  it("cuts off a body larger than the drain bound", async () => {
    const chunks = Array.from({ length: 2 * ABANDON_LIMITS.bytes / (64 * 1024) }, () => kb(64));
    const b = body(chunks);
    const peeked = await peek(b.stream);
    await peeked.cancel("rejected");
    expect(b.cancel).toHaveBeenCalledWith("rejected");
    expect(b.pulled()).toBeLessThanOrEqual(ABANDON_LIMITS.bytes / (64 * 1024) + 1);
  });

  it("drains once however many paths give up on the body", async () => {
    const chunks = Array.from({ length: 4 * ABANDON_LIMITS.bytes / (64 * 1024) }, () => kb(64));
    const b = body(chunks);
    const peeked = await peek(b.stream);
    await Promise.all([peeked.stream.cancel("a"), peeked.cancel("b"), peeked.cancel("c")]);
    expect(b.pulled()).toBeLessThanOrEqual(ABANDON_LIMITS.bytes / (64 * 1024) + 1);
    expect(b.cancel).toHaveBeenCalledOnce();
  });
});
