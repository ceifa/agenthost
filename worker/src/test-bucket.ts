// In-memory R2 fixture: list ordering, delimiter/cursor behavior and metadata
// projection matter to these tests just as much as object bodies do.
import { vi } from "vitest";
import type { Env } from "./env";

interface Stored { body: string; customMetadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata }
export function testBucket(pageSize = 1000) {
  const records = new Map<string, Stored>();
  const object = (key: string, value: Stored) => ({
    key, size: new TextEncoder().encode(value.body).length,
    httpEtag: '"test-etag"', uploaded: new Date(0),
    customMetadata: value.customMetadata, httpMetadata: value.httpMetadata,
    writeHttpMetadata: (h: Headers) => { if (value.httpMetadata?.contentType) h.set("content-type", value.httpMetadata.contentType); },
  });
  const get = vi.fn(async (key: string) => {
    const value = records.get(key);
    if (!value) return null;
    const res = new Response(value.body);
    return { ...object(key, value), body: res.body, text: () => res.text(), json: () => res.json() };
  });
  const head = vi.fn(async (key: string) => {
    const value = records.get(key);
    return value ? object(key, value) : null;
  });
  const put = vi.fn(async (key: string, body: unknown, opts?: R2PutOptions) => {
    const bytes = body instanceof ReadableStream ? await new Response(body as ReadableStream<Uint8Array>).text()
      : typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
    records.set(key, { body: bytes, customMetadata: opts?.customMetadata, httpMetadata: opts?.httpMetadata as R2HTTPMetadata });
    return object(key, records.get(key)!);
  });
  const list = vi.fn(async (opts: R2ListOptions & { include?: string[] } = {}) => {
    const prefix = opts.prefix ?? "";
    const keys = [...records.keys()].filter(k => k.startsWith(prefix)).sort();
    const entries = [...new Set(keys.map(k => {
      const end = opts.delimiter ? k.indexOf(opts.delimiter, prefix.length) : -1;
      return end < 0 ? k : k.slice(0, end + opts.delimiter!.length);
    }))];
    const remaining = entries.filter(k => !opts.cursor || k > opts.cursor);
    const selected = remaining.slice(0, Math.min(pageSize, opts.limit ?? 1000));
    const objects = selected.filter(k => records.has(k)).map(k => {
      const obj = object(k, records.get(k)!);
      if (!opts.include?.includes("customMetadata")) delete obj.customMetadata;
      return obj;
    });
    const truncated = remaining.length > selected.length;
    return { objects, delimitedPrefixes: selected.filter(k => !records.has(k)), truncated, cursor: truncated ? selected.at(-1) : undefined };
  });
  const del = vi.fn(async (key: string | string[]) => { for (const k of typeof key === "string" ? [key] : key) records.delete(k); });
  const bucket = { get, head, put, list, delete: del } as unknown as R2Bucket;
  const json = (key: string, value: unknown, indexed = false) => records.set(key, indexed
    ? { body: "", customMetadata: { json: JSON.stringify(value) } } : { body: JSON.stringify(value) });
  const env = { SITES: bucket, DEV_MODE: "1", APEX_HOST: "example.com", PUBLISH_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
  return { bucket, records, get, head, put, list, del, json, env };
}
