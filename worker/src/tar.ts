// Self-contained, zero-dependency streaming tar reader.
//
// A tar entry is a 512-byte header followed by content padded up to a 512-byte
// boundary. We read the input ReadableStream and yield one entry at a time, its
// contents as a stream of the input's own chunks — sliced, never copied or
// buffered whole — so a file flows to R2 without the Worker touching its bytes.
// Handles ustar, GNU long names ('L'), and PAX extended headers ('x', which
// macOS/bsdtar emits) so the canonical `tar czf -` pipe works everywhere.

export type TarEntryType = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  path: string;
  type: TarEntryType;
  size: number;
  /**
   * Entry contents (only meaningful for `file`), exactly `size` bytes. Read it
   * to the end, or not at all, before advancing the iterator: unread bytes are
   * skipped then, and the stream closes.
   */
  body: ReadableStream<Uint8Array>;
}

/** Thrown when an entry's declared size exceeds the configured cap. */
export class TarLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarLimitError";
  }
}

const BLOCK = 512;
const TAIL_MAX = 1024 * 1024;

/** Pulls exactly-sized byte runs out of a chunked ReadableStream. */
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async pull(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done) {
      this.done = true;
      return;
    }
    if (value && value.length) {
      this.queue.push(value);
      this.queued += value.length;
    }
  }

  /** Read up to `n` bytes. Returns fewer only at end of stream; null if empty. */
  async read(n: number): Promise<Uint8Array | null> {
    while (this.queued < n && !this.done) await this.pull();
    if (this.queued === 0) return null;
    const take = Math.min(n, this.queued);
    const out = new Uint8Array(take);
    let off = 0;
    while (off < take) {
      const head = this.queue[0]!;
      const need = take - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.queue.shift();
        this.queued -= head.length;
      } else {
        out.set(head.subarray(0, need), off);
        off += need;
        this.queue[0] = head.subarray(need);
        this.queued -= need;
      }
    }
    return out;
  }

  /** The next run of up to `max` bytes, as a slice of an input chunk; null at end of stream. */
  async chunk(max: number): Promise<Uint8Array | null> {
    while (this.queued === 0 && !this.done) await this.pull();
    if (this.queued === 0) return null;
    const head = this.queue[0]!;
    if (head.length <= max) {
      this.queue.shift();
      this.queued -= head.length;
      return head;
    }
    this.queue[0] = head.subarray(max);
    this.queued -= max;
    return head.subarray(0, max);
  }

  /** Discard up to `n` bytes; returns how many were left unskipped at end of stream. */
  async skip(n: number): Promise<number> {
    while (n > 0) {
      const c = await this.chunk(n);
      if (!c) break;
      n -= c.length;
    }
    return n;
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function isZeroBlock(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

const DECODER = new TextDecoder();

function readString(b: Uint8Array, off: number, len: number): string {
  let end = off;
  const limit = off + len;
  while (end < limit && b[end] !== 0) end++;
  return DECODER.decode(b.subarray(off, end));
}

function readOctal(b: Uint8Array, off: number, len: number): number {
  // GNU base-256 encoding (high bit of first byte set) — used only for huge
  // values we cap out well below, but handle it so we never misread a size.
  if ((b[off]! & 0x80) !== 0) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i]!;
    return v;
  }
  const s = readString(b, off, len).trim();
  if (!s) return 0;
  const v = parseInt(s, 8);
  return Number.isFinite(v) ? v : 0;
}

/** Parse PAX extended-header records ("<len> key=value\n"). */
function parsePax(body: Uint8Array): Record<string, string> {
  const text = DECODER.decode(body);
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const len = parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1); // drop trailing "\n"
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

function typeFromFlag(flag: string): TarEntryType {
  switch (flag) {
    case "0":
    case "\0":
    case "7":
      return "file";
    case "5":
      return "dir";
    case "2":
      return "symlink";
    case "1":
      return "hardlink";
    default:
      return "other";
  }
}

// One entry's contents, pulled from the shared reader only as the consumer reads.
class EntryBody {
  readonly stream: ReadableStream<Uint8Array>;
  private remaining: number;
  private reading: Promise<void> | null = null;
  private detached = false;

  constructor(
    private readonly r: ByteReader,
    size: number,
  ) {
    this.remaining = size;
    // highWaterMark 0: nothing is read ahead, so bytes nobody asked for stay in
    // the reader for skip() instead of racing it.
    this.stream = new ReadableStream<Uint8Array>(
      { pull: (c) => (this.reading = this.pull(c)) },
      { highWaterMark: 0 },
    );
  }

  private async pull(c: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.detached || this.remaining === 0) return c.close();
    const chunk = await this.r.chunk(this.remaining);
    if (!chunk) throw new Error("truncated tar entry");
    this.remaining -= chunk.length;
    c.enqueue(chunk);
    if (this.remaining === 0) c.close();
  }

  // Called when the iterator advances: let an in-flight read land, then skip
  // whatever the consumer left unread.
  async finish(): Promise<void> {
    this.detached = true;
    await this.reading?.catch(() => {});
    if ((await this.r.skip(this.remaining)) > 0) throw new Error("truncated tar entry");
    this.remaining = 0;
  }
}

/**
 * Async-iterate the entries of a (decompressed) tar stream. Caller pipes:
 *   request.body → gunzipStream(...) → parseTar(...)
 */
export async function* parseTar(
  stream: ReadableStream<Uint8Array>,
  opts: { maxEntrySize?: number } = {},
): AsyncGenerator<TarEntry> {
  const r = new ByteReader(stream);
  let gnuLongName: string | null = null;
  let paxPath: string | null = null;

  try {
    while (true) {
      const header = await r.read(BLOCK);
      if (!header || header.length === 0) break; // clean EOF
      if (header.length < BLOCK) break; // truncated tail; stop cleanly
      if (isZeroBlock(header)) {
        // End-of-archive marker. tar pads the archive out to a whole record
        // (10 KiB by default) past it; read that tail rather than cancel the
        // body under it — an unread request body stalls the connection's next
        // request (seen in workerd). Bounded, so junk past it isn't slurped.
        await r.skip(TAIL_MAX);
        break;
      }

      let name = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
      const size = readOctal(header, 124, 12);
      const typeflag = String.fromCharCode(header[156]!);

      // Cap the declared size before reading the body. Applies to every entry:
      // metadata (GNU long-name / PAX) is read into memory, so an inflated size
      // there is the OOM vector, and a file's is the caller's per-file limit.
      if (opts.maxEntrySize !== undefined && size > opts.maxEntrySize) {
        throw new TarLimitError(`entry ${name || "?"} declares ${size} bytes; max is ${opts.maxEntrySize}`);
      }
      const padding = Math.ceil(size / BLOCK) * BLOCK - size;

      // Metadata-only entries that rename the *next* real entry. Small, so read whole.
      if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
        const body = size > 0 ? await r.read(size) : new Uint8Array(0);
        if (!body || body.length < size) throw new Error("truncated tar entry");
        await r.skip(padding);
        if (typeflag === "L") gnuLongName = readString(body, 0, body.length).replace(/\0+$/, "");
        if (typeflag === "x") paxPath = parsePax(body)["path"] || paxPath;
        continue; // 'K' (GNU long linkname) and 'g' (global PAX) are irrelevant
      }

      const effectiveName = paxPath ?? gnuLongName ?? name;
      paxPath = null;
      gnuLongName = null;

      const body = new EntryBody(r, size);
      // Nameless entries are skipped, but their bytes still have to be.
      if (effectiveName) yield { path: effectiveName, type: typeFromFlag(typeflag), size, body: body.stream };
      await body.finish();
      await r.skip(padding); // a short final pad is a truncated tail, not an error
    }
  } finally {
    await r.cancel();
  }
}
