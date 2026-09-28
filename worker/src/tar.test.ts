import { describe, expect, it } from "vitest";
import { parseTar, TarLimitError, type TarEntry } from "./tar";

const enc = new TextEncoder();

// Minimal ustar writer: enough header for the parser (name, size, typeflag).
function header(name: string, size: number, flag = "0"): Uint8Array {
  const h = new Uint8Array(512);
  h.set(enc.encode(name).subarray(0, 100), 0);
  h.set(enc.encode(size.toString(8).padStart(11, "0")), 124);
  h[156] = flag.charCodeAt(0);
  h.set(enc.encode("ustar\0"), 257);
  return h;
}

function tar(entries: { name: string; body?: Uint8Array; flag?: string }[], end = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const body = e.body ?? new Uint8Array(0);
    parts.push(header(e.name, body.length, e.flag), body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  if (end) parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Chunks are views of the one source buffer, like a request body's.
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= bytes.length) return c.close();
      c.enqueue(bytes.subarray(off, off + size));
      off += size;
    },
  });
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
}

async function chunksOf(e: TarEntry): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const c of e.body) out.push(c);
  return out;
}

function concat(cs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(cs.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of cs) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe("parseTar", () => {
  it("streams file contents as views of the input, never copies", async () => {
    const big = random(300_000);
    const archive = tar([{ name: "a.bin", body: big }, { name: "b.txt", body: enc.encode("hi") }]);
    const got: Record<string, Uint8Array> = {};
    for await (const e of parseTar(chunked(archive, 8192))) {
      const cs = await chunksOf(e);
      for (const c of cs) expect(c.buffer).toBe(archive.buffer);
      got[e.path] = concat(cs);
    }
    expect(got["a.bin"]).toEqual(big);
    expect(new TextDecoder().decode(got["b.txt"])).toBe("hi");
  });

  it("skips the contents of entries nobody reads", async () => {
    const archive = tar([
      { name: "._cruft", body: random(5000) },
      { name: "dir/", flag: "5" },
      { name: "keep.txt", body: enc.encode("kept") },
    ]);
    const seen: string[] = [];
    for await (const e of parseTar(chunked(archive, 700))) {
      seen.push(e.path);
      if (e.path === "keep.txt") expect(new TextDecoder().decode(concat(await chunksOf(e)))).toBe("kept");
    }
    expect(seen).toEqual(["._cruft", "dir/", "keep.txt"]);
  });

  it("skips the rest of an entry read only partway", async () => {
    const archive = tar([{ name: "a", body: random(50_000) }, { name: "b", body: enc.encode("b") }]);
    const seen: string[] = [];
    for await (const e of parseTar(chunked(archive, 4096))) {
      seen.push(e.path);
      if (e.path === "a") {
        const r = e.body.getReader();
        await r.read();
        r.releaseLock();
      } else expect(concat(await chunksOf(e))).toEqual(enc.encode("b"));
    }
    expect(seen).toEqual(["a", "b"]);
  });

  it("names entries from PAX and GNU long-name headers", async () => {
    const long = "deep/".repeat(30) + "file.md";
    const pax = enc.encode(`${long.length + 7 + String(long.length + 7).length} path=${long}\n`);
    const archive = tar([
      { name: "PaxHeader", body: pax, flag: "x" },
      { name: "short-a", body: enc.encode("a") },
      { name: "././@LongLink", body: enc.encode(long + "2\0"), flag: "L" },
      { name: "short-b", body: enc.encode("b") },
    ]);
    const paths: string[] = [];
    for await (const e of parseTar(chunked(archive, 512))) paths.push(e.path);
    expect(paths).toEqual([long, long + "2"]);
  });

  it("delivers empty files", async () => {
    const archive = tar([{ name: "empty" }, { name: "x", body: enc.encode("x") }]);
    const sizes: number[] = [];
    for await (const e of parseTar(chunked(archive, 512))) sizes.push(concat(await chunksOf(e)).length);
    expect(sizes).toEqual([0, 1]);
  });

  it("stops cleanly at a missing end-of-archive marker", async () => {
    const archive = tar([{ name: "a", body: enc.encode("a") }], false);
    const paths: string[] = [];
    for await (const e of parseTar(chunked(archive, 512))) paths.push(e.path);
    expect(paths).toEqual(["a"]);
  });

  // Cancelling a request body with tar's record padding still unread stalled the
  // next request on the connection; the parser reads that tail instead.
  it("reads the record padding past the end-of-archive marker", async () => {
    const archive = tar([{ name: "a", body: enc.encode("a") }]);
    const padded = new Uint8Array(archive.length + 9216);
    padded.set(archive);
    let cancelled = false;
    let off = 0;
    const src = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= padded.length) return c.close();
        c.enqueue(padded.subarray(off, off + 512));
        off += 512;
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const e of parseTar(src)) await chunksOf(e);
    expect(off).toBe(padded.length);
    expect(cancelled).toBe(false);
  });

  it("fails a truncated entry, read or not", async () => {
    const archive = tar([{ name: "a", body: random(4000) }]).subarray(0, 2048);
    const read = async () => {
      for await (const e of parseTar(chunked(archive, 512))) await chunksOf(e);
    };
    const skip = async () => {
      for await (const _ of parseTar(chunked(archive, 512))) void _;
    };
    await expect(read()).rejects.toThrow("truncated tar entry");
    await expect(skip()).rejects.toThrow("truncated tar entry");
  });

  it("rejects an entry over the size cap before reading it", async () => {
    const archive = tar([{ name: "a", body: random(2000) }]);
    const run = async () => {
      for await (const _ of parseTar(chunked(archive, 512), { maxEntrySize: 1000 })) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(TarLimitError);
  });
});
