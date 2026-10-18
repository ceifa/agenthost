// Minimal ustar writer for tests: enough header for the parser (name, size,
// typeflag).
export const enc = new TextEncoder();

export function header(name: string, size: number, flag = "0"): Uint8Array {
  const h = new Uint8Array(512);
  h.set(enc.encode(name).subarray(0, 100), 0);
  h.set(enc.encode(size.toString(8).padStart(11, "0")), 124);
  h[156] = flag.charCodeAt(0);
  h.set(enc.encode("ustar\0"), 257);
  return h;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export function tar(entries: { name: string; body?: Uint8Array | string; flag?: string }[], end = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const body = typeof e.body === "string" ? enc.encode(e.body) : e.body ?? new Uint8Array(0);
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
