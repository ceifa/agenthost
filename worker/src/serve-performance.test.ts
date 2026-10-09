import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSite, cacheKeyPath } from "./serve";
import { sha256Hex } from "./ids";
import type { Env } from "./env";

const prefix = "sites/u/docs/";
const controlKeys = [prefix + "_meta", prefix + "_gen"];

function fixture(files: Record<string, string>) {
  const meta = { public: true, keyHash: null as string | null, tombstone: false };
  const objects = new Map(Object.entries(files).map(([path, body]) => [prefix + path, body]));
  objects.set(prefix + "_gen", "1");
  const cacheEntries = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const cache = {
    match: vi.fn(async (req: Request) => {
      const hit = cacheEntries.get(req.url);
      // Each match has its own body, not a tee of a retained, unread response
      // (cancelling one tee branch waits for the other branch to finish).
      return hit ? new Response(await hit.clone().arrayBuffer(), hit) : undefined;
    }),
    put: vi.fn(async (req: Request, res: Response) => {
      // Consume the cache branch as the Cache API does, including streamed bodies.
      cacheEntries.set(req.url, new Response(await res.arrayBuffer(), res));
    }),
  };
  const bucket = {
    get: vi.fn(async (key: string, _opts?: unknown) => {
      const content = key === prefix + "_meta" ? JSON.stringify(meta) : objects.get(key);
      if (content === undefined) return null;
      const response = new Response(content);
      return {
        body: response.body,
        text: () => response.text(),
        json: () => response.json(),
        size: new TextEncoder().encode(content).length,
        httpEtag: '"fixture-etag"',
        uploaded: new Date("2026-01-01T00:00:00Z"),
        writeHttpMetadata: (headers: Headers) => headers.set("content-type", "text/plain"),
      };
    }),
    head: vi.fn(async (key: string) => objects.has(key) ? { key } : null),
    list: vi.fn(async () => ({ objects: [...objects.keys()].map((key) => ({ key })), truncated: false })),
  };
  vi.stubGlobal("caches", { default: cache });
  // HTML rewriting is exercised by the workerd smoke check; this fixture tests
  // the request's storage/cache I/O and whether it hands off a streaming body.
  vi.stubGlobal("HTMLRewriter", class {
    on() { return this; }
    transform(response: Response) { return response; }
  });
  const env = { SITES: bucket, APEX_HOST: "example.com" } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
  const request = (path = "/", headers?: HeadersInit) =>
    handleSite(new Request("https://u-docs.example.com" + path, { headers }), env, ctx, "u", "docs", "u-docs.example.com");
  const settle = async () => { await Promise.all(pending.splice(0)); };
  const warm = async (path = "/") => {
    await (await request(path)).text();
    await settle();
    vi.clearAllMocks();
  };
  return { meta, objects, bucket, cache, cacheEntries, request, settle, warm };
}

afterEach(() => vi.unstubAllGlobals());

describe("serving I/O budgets", () => {
  it.each<{ name: string; files: Record<string, string>; path: string }>([
    { name: "static asset", files: { "app.css": "body{}" }, path: "/app.css" },
    { name: "directory HTML", files: { "guide/index.html": "<body>Guide</body>" }, path: "/guide" },
    { name: "Markdown homepage", files: { "README.md": "# Home", "SUMMARY.md": "- [Home](README.md)" }, path: "/" },
  ])("only reads fresh access metadata and generation for a warm $name", async ({ files, path }) => {
    const f = fixture(files);
    await f.warm(path);
    const res = await f.request(path);
    expect(res.status).toBe(200);
    await res.text();
    await f.settle();
    expect(f.bucket.get.mock.calls.map(([key]) => key).sort()).toEqual([...controlKeys].sort());
    expect(f.bucket.head).not.toHaveBeenCalled();
    expect(f.bucket.list).not.toHaveBeenCalled();
  });

  it("resolves a new homepage immediately after the generation changes", async () => {
    const f = fixture({ "README.md": "# Old home" });
    await f.warm();
    f.objects.set(prefix + "index.html", "<body>New home</body>");
    f.objects.set(prefix + "_gen", "2");
    expect(await (await f.request()).text()).toContain("New home");
    expect(f.bucket.head).toHaveBeenCalledWith(prefix + "index.html");
    await f.settle();
  });

  it("rebuilds a Markdown body when the route survives body-cache eviction", async () => {
    const f = fixture({ "README.md": "# Home", "next.md": "# Next" });
    await f.warm();
    f.cacheEntries.delete(cacheKeyPath("u", "docs", 1, { kind: "md", relPath: "README.md" }, false));
    const html = await (await f.request()).text();
    expect(html).toContain("Home");
    expect(html).toContain('href="/next.md"');
    expect(f.bucket.head).not.toHaveBeenCalled();
    expect(f.bucket.list).toHaveBeenCalledOnce();
    await f.settle();
  });

  it("keeps raw Markdown separate from the rendered page", async () => {
    const f = fixture({ "README.md": "# Home" });
    await f.warm();
    const raw = await f.request("/?raw");
    expect(await raw.text()).toBe("# Home");
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await f.settle();
    expect(await (await f.request()).text()).toContain('<h1 id="home">');
  });

  it("does not cache missing routes or expose control objects", async () => {
    const f = fixture({});
    expect((await f.request("/_meta")).status).toBe(404);
    expect((await f.request("/new.css")).status).toBe(404);
    await f.settle();
    expect(f.cache.put).not.toHaveBeenCalled();
    f.objects.set(prefix + "new.css", "body{}");
    expect(await (await f.request("/new.css")).text()).toBe("body{}");
    await f.settle();
  });

  it("honors a public-to-private change and takedown before reading any cached content", async () => {
    const f = fixture({ "index.html": "<body>Secret</body>" });
    await f.warm();
    f.meta.public = false;
    f.meta.keyHash = await sha256Hex("new-key");
    expect((await f.request()).status).toBe(401);
    expect(f.cache.match).not.toHaveBeenCalled();
    f.meta.tombstone = true;
    expect((await f.request()).status).toBe(410);
    expect(f.cache.match).not.toHaveBeenCalled();
  });

  it("checks rotated keys on warm routes without caching reader credentials", async () => {
    const f = fixture({ "index.html": "<body>Secret</body>" });
    f.meta.public = false;
    f.meta.keyHash = await sha256Hex("old-key");
    expect((await f.request("/", { cookie: "as_auth_docs=old-key" })).status).toBe(200);
    await f.settle();
    f.meta.keyHash = await sha256Hex("new-key");
    expect((await f.request("/", { cookie: "as_auth_docs=old-key" })).status).toBe(401);
    expect((await f.request("/", { cookie: "as_auth_docs=new-key" })).status).toBe(200);
    const login = await f.request("/?k=new-key");
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie")).toContain("as_auth_docs=new-key");
    for (const [key, response] of f.cacheEntries) {
      expect(key).not.toMatch(/old-key|new-key/);
      expect(await response.clone().text()).not.toMatch(/old-key|new-key/);
    }
  });
});

describe("streamed HTML", () => {
  it.each([false, true])("returns HTML before its source closes (cached: %s)", async (cached) => {
    const f = fixture({ "index.html": "<body>Home</body>" });
    if (cached) await f.warm();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    controller.enqueue(new TextEncoder().encode("<body>First"));
    if (cached) {
      const original = f.cache.match.getMockImplementation()!;
      f.cache.match.mockImplementation(async (req) =>
        req.url === cacheKeyPath("u", "docs", 1, { kind: "html", relPath: "index.html" }, false)
          ? new Response(stream) : original(req));
    } else {
      const original = f.bucket.get.getMockImplementation()!;
      f.bucket.get.mockImplementation(async (key, opts) => {
        const obj = await original(key, opts);
        return key === prefix + "index.html" && obj ? {
          ...obj, body: stream,
          text: () => { throw new Error("HTML must not be buffered"); },
        } : obj;
      });
    }
    let response: Response | undefined;
    const serving = f.request().then((res) => { response = res; });
    try {
      // The tail is deliberately withheld until handleSite returns a response.
      await vi.waitFor(() => expect(response).toBeDefined(), { timeout: 1000 });
    } finally {
      controller.enqueue(new TextEncoder().encode("Last</body>"));
      controller.close();
      await serving;
    }
    expect(await response!.text()).toBe("<body>FirstLast</body>");
    expect(response!.headers.get("cache-control")).toBe("no-cache");
    expect(response!.headers.get("x-robots-tag")).toContain("noindex");
    await f.settle();
  });
});

describe("static conditional cache requests", () => {
  it.each<{ headers: Record<string, string>; status: number; body: string | null }>([
    { headers: { "if-none-match": '"fixture-etag"' }, status: 304, body: null },
    { headers: { "if-modified-since": "Thu, 01 Jan 2026 00:00:00 GMT" }, status: 304, body: null },
    { headers: { range: "bytes=0-3" }, status: 206, body: "body" },
  ])("delegates $headers to the edge cache without reading the object", async ({ headers, status, body }) => {
    const f = fixture({ "app.css": "body{}" });
    await f.warm("/app.css");
    const original = f.cache.match.getMockImplementation()!;
    f.cache.match.mockImplementation(async (req) => {
      if (req.url === cacheKeyPath("u", "docs", 1, { kind: "static", relPath: "app.css" }, false)) {
        expect(Object.fromEntries(req.headers)).toEqual(headers);
        return new Response(body, { status, headers: { "cache-control": "public, max-age=31536000" } });
      }
      return original(req);
    });
    const res = await f.request("/app.css", { ...headers, cookie: "unrelated=private" });
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(body ?? "");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(f.bucket.get.mock.calls.map(([key]) => key).sort()).toEqual([...controlKeys].sort());
  });

  it("stores length and modification time for native cache range/validator support", async () => {
    const f = fixture({ "app.css": "body{}" });
    await f.warm("/app.css");
    const cached = f.cacheEntries.get(cacheKeyPath("u", "docs", 1, { kind: "static", relPath: "app.css" }, false))!;
    expect(cached.headers.get("content-length")).toBe("6");
    expect(cached.headers.get("last-modified")).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
    expect(cached.headers.get("etag")).toBe('"fixture-etag"');
  });

  it("preserves conditional R2 options when the body cache misses", async () => {
    const f = fixture({ "app.css": "body{}" });
    await f.warm("/app.css");
    f.cacheEntries.delete(cacheKeyPath("u", "docs", 1, { kind: "static", relPath: "app.css" }, false));
    await (await f.request("/app.css", { "if-none-match": '"old"' })).text();
    const [, opts] = f.bucket.get.mock.calls.find(([key]) => key === prefix + "app.css")!;
    expect((opts as { onlyIf: Headers }).onlyIf.get("if-none-match")).toBe('"old"');
    expect(f.cache.put).not.toHaveBeenCalled();
  });

  it.each([
    { header: "if-modified-since", value: "Thu, 01 Jan 2026 00:00:00 GMT", missing: "last-modified" },
    { header: "range", value: "bytes=0-3", missing: "content-length" },
  ])("falls back to R2 when a legacy cache entry lacks $missing", async ({ header, value, missing }) => {
    const f = fixture({ "app.css": "body{}" });
    await f.warm("/app.css");
    const cached = f.cacheEntries.get(cacheKeyPath("u", "docs", 1, { kind: "static", relPath: "app.css" }, false))!;
    cached.headers.delete(missing);
    await (await f.request("/app.css", { [header]: value })).text();
    expect(f.bucket.get.mock.calls.some(([key]) => key === prefix + "app.css")).toBe(true);
    await f.settle();
  });
});
