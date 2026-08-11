// Body-first detection for POST /publish: what is this payload, really?
//
// The Content-Type header is unreliable in practice — `curl --data-binary @x.md`
// with no `-H` sends `application/x-www-form-urlencoded`, most uploaders send
// `application/octet-stream` for everything, and agents simply forget the flag.
// Trusting it means a perfectly good markdown file gets shoved down the tar path
// and dies as "bad archive". So we peek the first bytes instead: gzip/tar magic is
// decisive for the archive path, and front matter / an html tag tells markdown
// from html for the single-document path.

/** Bytes peeked before deciding. Covers the tar magic at offset 257 plus slack. */
export const SNIFF_BYTES = 1024;

export interface Peeked {
  /** First bytes of the body (shorter only if the body itself is shorter). */
  head: Uint8Array;
  /** The body, intact — the peeked bytes are replayed ahead of the remainder. */
  stream: ReadableStream<Uint8Array>;
}

// Reads up to `n` bytes *without* consuming them: the returned stream replays the
// buffered head and then hands out the untouched rest, so both the single-file
// reader and the tar parser still see a complete body.
export async function peek(input: ReadableStream<Uint8Array>, n = SNIFF_BYTES): Promise<Peeked> {
  const reader = input.getReader();
  const buffered: Uint8Array[] = [];
  let total = 0;
  let ended = false;

  while (total < n) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    if (!value?.byteLength) continue;
    buffered.push(value);
    total += value.byteLength;
  }

  const head = new Uint8Array(Math.min(total, n));
  let off = 0;
  for (const chunk of buffered) {
    if (off >= head.byteLength) break;
    const slice = chunk.subarray(0, head.byteLength - off);
    head.set(slice, off);
    off += slice.byteLength;
  }

  let replayed = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        for (const chunk of buffered) controller.enqueue(chunk);
        if (ended) controller.close();
        return;
      }
      if (ended) return;
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        controller.close();
        return;
      }
      if (value?.byteLength) controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return { head, stream };
}

/** gzip member header (RFC 1952): 1f 8b. */
export function isGzip(head: Uint8Array): boolean {
  return head.byteLength >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** Uncompressed tar: "ustar" magic at offset 257 of the first 512-byte header. */
export function isTar(head: Uint8Array): boolean {
  if (head.byteLength < 262) return false;
  return (
    head[257] === 0x75 && head[258] === 0x73 && head[259] === 0x74 && head[260] === 0x61 && head[261] === 0x72
  );
}

/** zip/deflate archives — recognized only so the error can say what's wrong. */
export function isZip(head: Uint8Array): boolean {
  return head.byteLength >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

// A NUL or a stray C0 control byte never occurs in a text document, so it marks
// the body as binary (a png, pdf, or a truncated archive) rather than a document.
function looksBinary(head: Uint8Array): boolean {
  for (const b of head) {
    if (b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d) continue; // tab, LF, FF, CR
    if (b < 0x20 || b === 0x7f) return true;
  }
  return false;
}

// Openers that mean "this is a web page", not prose — deliberately only the tags
// that open a *document*. Container tags (`<div>`, `<p align=center>`, `<table>`)
// are left out on purpose: markdown files routinely start with one for a centered
// title, and misreading those as html serves the markdown source raw, while an
// html fragment misread as markdown still renders (marked passes raw html
// through). The cheaper mistake wins.
const HTML_OPENERS = /^<(!doctype\s+html|\?xml|html[\s>]|head[\s>]|body[\s>]|meta\b|link\b|title>|script\b|style\b|svg\b)/i;

/**
 * html vs markdown for a lone document with no usable Content-Type; `null` when
 * the body is binary and therefore neither.
 */
export function sniffDocKind(head: Uint8Array): "html" | "md" | null {
  if (looksBinary(head)) return null;

  let text = new TextDecoder().decode(head); // strips a UTF-8 BOM for us
  // YAML front matter is a markdown convention — decisive on its own.
  if (/^---\r?\n/.test(text)) return "md";

  text = text.replace(/^\s+/, "");
  // Skip leading html comments so `<!-- generated -->\n<html>` still reads as html.
  for (;;) {
    const stripped = text.replace(/^<!--[\s\S]*?-->\s*/, "");
    if (stripped === text) break;
    text = stripped;
  }
  return HTML_OPENERS.test(text) ? "html" : "md";
}
