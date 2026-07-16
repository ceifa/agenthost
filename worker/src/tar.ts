// Self-contained, zero-dependency streaming tar reader.
//
// A tar entry is a 512-byte header followed by content padded up to a 512-byte
// boundary. We read the input ReadableStream block-by-block and yield one entry
// at a time, buffering only the *current* entry's bytes — never the whole
// archive. Handles ustar, GNU long names ('L'), and PAX extended headers ('x',
// which macOS/bsdtar emits) so the canonical `tar czf -` pipe works everywhere.

export type TarEntryType = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  path: string;
  type: TarEntryType;
  size: number;
  /** Entry contents (only meaningful for `file`). Backed by a per-entry buffer. */
  body: Uint8Array;
}

/** Thrown when an entry's declared size exceeds the configured cap. */
export class TarLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarLimitError";
  }
}

const BLOCK = 512;

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

/**
 * Async-iterate the entries of a (decompressed) tar stream. Caller pipes:
 *   request.body.pipeThrough(new DecompressionStream("gzip")) → parseTar(...)
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
      if (isZeroBlock(header)) break; // end-of-archive marker

      let name = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
      const size = readOctal(header, 124, 12);
      const typeflag = String.fromCharCode(header[156]!);

      // Cap the declared size BEFORE buffering the body. Applies to every entry
      // (file *and* metadata like GNU long-name / PAX), since each reads its body
      // into memory — an inflated size here is the decompression-bomb/OOM vector.
      if (opts.maxEntrySize !== undefined && size > opts.maxEntrySize) {
        throw new TarLimitError(`entry ${name || "?"} declares ${size} bytes; max is ${opts.maxEntrySize}`);
      }

      // Read padded content for this header.
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      let content: Uint8Array = new Uint8Array(0);
      if (padded > 0) {
        const got = await r.read(padded);
        if (!got || got.length < size) {
          throw new Error("truncated tar entry");
        }
        content = got;
      }
      const body = content.subarray(0, size);

      // Metadata-only entries that rename the *next* real entry.
      if (typeflag === "L") {
        gnuLongName = readString(body, 0, body.length).replace(/\0+$/, "");
        continue;
      }
      if (typeflag === "K") continue; // GNU long linkname — irrelevant
      if (typeflag === "x" || typeflag === "g") {
        const rec = parsePax(body);
        if (typeflag === "x" && rec["path"]) paxPath = rec["path"];
        continue;
      }

      const effectiveName = paxPath ?? gnuLongName ?? name;
      paxPath = null;
      gnuLongName = null;

      if (!effectiveName) continue; // skip nameless entries

      yield { path: effectiveName, type: typeFromFlag(typeflag), size, body };
    }
  } finally {
    await r.cancel();
  }
}
