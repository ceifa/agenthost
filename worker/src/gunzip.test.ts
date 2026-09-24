import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import { gunzipStream } from "./gunzip";
import { peek } from "./sniff";

// A body arriving in network-sized pieces, optionally with empty chunks between.
function chunked(bytes: Uint8Array, size: number, emptyEvery = 0): ReadableStream<Uint8Array> {
  let off = 0;
  let n = 0;
  return new ReadableStream({
    pull(c) {
      if (emptyEvery && ++n % emptyEvery === 0) return c.enqueue(new Uint8Array(0));
      if (off >= bytes.length) return c.close();
      c.enqueue(bytes.slice(off, off + size));
      off += size;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
}

describe("gunzipStream", () => {
  // Incompressible data (a video, a jpeg) deflates to stored blocks, and fflate
  // holds a stored block until it's whole — so an input chunk can produce no
  // output. The stream used to stall there and the Worker never answered (1101).
  it("keeps pulling when a chunk inflates to nothing", async () => {
    const raw = random(600 * 1024);
    const out = await drain(gunzipStream(chunked(gzipSync(raw), 16 * 1024)));
    expect(out.length).toBe(raw.length);
    expect(out).toEqual(raw);
  }, 5000);

  it("inflates compressible data", async () => {
    const raw = new TextEncoder().encode("agenthost ".repeat(100_000));
    expect(await drain(gunzipStream(chunked(gzipSync(raw), 4096)))).toEqual(raw);
  });
});

describe("peek", () => {
  it("replays the head and passes empty chunks through without stalling", async () => {
    const raw = random(200 * 1024);
    const { head, stream } = await peek(chunked(raw, 8192, 3));
    expect(head).toEqual(raw.subarray(0, head.length));
    expect(await drain(stream)).toEqual(raw);
  }, 5000);
});
