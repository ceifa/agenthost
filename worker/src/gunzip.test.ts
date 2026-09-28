import { describe, expect, it } from "vitest";
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

async function gzip(raw: Uint8Array): Promise<Uint8Array> {
  return drain(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")));
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
}

describe("gunzipStream", () => {
  // Incompressible data (a video, a jpeg) deflates to stored blocks, and an
  // inflater may hold one until it's whole — so an input chunk can produce no
  // output. The stream used to stall there and the Worker never answered (1101).
  it("keeps pulling when a chunk inflates to nothing", async () => {
    const raw = random(600 * 1024);
    const out = await drain(gunzipStream(chunked(await gzip(raw), 16 * 1024)));
    expect(out.length).toBe(raw.length);
    expect(out).toEqual(raw);
  }, 5000);

  it("inflates compressible data", async () => {
    const raw = new TextEncoder().encode("agenthost ".repeat(100_000));
    expect(await drain(gunzipStream(chunked(await gzip(raw), 4096)))).toEqual(raw);
  });

  // `bsdtar czf -` to a pipe pads past the gzip member. DecompressionStream
  // rejected the padding and dropped the archive's tail with it.
  it("keeps the whole member when zero-padding trails it", async () => {
    const raw = random(300 * 1024);
    const gz = await gzip(raw);
    const padded = new Uint8Array(gz.length + 10240);
    padded.set(gz);
    for (const size of [1 << 20, 4096]) {
      expect(await drain(gunzipStream(chunked(padded, size)))).toEqual(raw);
    }
  });

  it("inflates across any chunk boundary", async () => {
    const raw = random(64 * 1024);
    const gz = await gzip(raw);
    for (const size of [1, 7, 509]) {
      expect(await drain(gunzipStream(chunked(gz, size)))).toEqual(raw);
    }
  });

  it("surfaces corruption that comes before any output", async () => {
    const junk = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xff, 0xff, 0xff]);
    await expect(drain(gunzipStream(chunked(junk, 4096)))).rejects.toThrow();
  });

  // Padding no longer errors, so an error mid-stream is a cut-off upload and
  // must fail the publish rather than pass as a shorter archive.
  it("surfaces a truncated member", async () => {
    const gz = await gzip(random(100 * 1024));
    await expect(drain(gunzipStream(chunked(gz.subarray(0, gz.length >> 1), 4096)))).rejects.toThrow();
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
