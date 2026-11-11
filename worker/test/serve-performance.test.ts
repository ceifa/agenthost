import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSite, cacheKeyPath } from "../src/serve";
import { sha256Hex } from "../src/ids";
import { CACHE_MAX_BYTES } from "../src/config";
import type { Env } from "../src/env";
import type { SiteMeta } from "../src/storage";

const prefix = "sites/u/docs/";
const controlKeys = ["_sites/u/docs"];

function fixture(files: Record<string, string>, types: Record<string, string> = {}) {
  const meta: Omit<SiteMeta, "bytes" | "fileCount" | "createdAt"> = { generation: 1, lastDeployAt: 1, public: true, tombstone: false };
  const objects = new Map(Object.entries(files).map(([path, body]) => [prefix + path, body]));
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
      const control = key === "_sites/u/docs";
      const content = control ? "" : objects.get(key);
      if (content === undefined) return null;
      const response = new Response(content);
      return {
        body: response.body,
        customMetadata: control ? { json: JSON.stringify(meta) } : undefined,
        text: () => response.text(),
        json: () => response.json(),
        size: new TextEncoder().encode(content).length,
        httpEtag: '"fixture-etag"',
        uploaded: new Date("2026-01-01T00:00:00Z"),
        writeHttpMetadata: (headers: Headers) => { if (types[key.slice(prefix.length)]) headers.set("content-type", types[key.slice(prefix.length)]!); },
      };
    }),
    head: vi.fn(async (key: string) => {
      const content = objects.get(key);
      return content === undefined ? null : { key, size: content.length, httpEtag: '"fixture-etag"', uploaded: new Date("2026-01-01T00:00:00Z"), writeHttpMetadata: (headers: Headers) => { if (types[key.slice(prefix.length)]) headers.set("content-type", types[key.slice(prefix.length)]!); } };
    }),
    list: vi.fn(async () => ({ objects: [...objects].map(([key, body]) => ({ key, size: body.length })), truncated: false })),
    put: vi.fn(async () => ({})),
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
  const request = (path = "/", headers?: HeadersInit, method = "GET") =>
    handleSite(new Request("https://u-docs.example.com" + path, { headers, method }), env, ctx, "u", "docs", "u-docs.example.com");
  const settle = async () => { await Promise.all(pending.splice(0)); };
  const warm = async (path = "/") => {
    await (await request(path)).text();
    await settle();
    vi.clearAllMocks();
  };
  return { meta, objects, bucket, cache, cacheEntries, request, settle, warm };
}

afterEach(() => vi.unstubAllGlobals());

// Which internal caches a request consulted, in order (visit bookkeeping aside).
const lookups = (f: ReturnType<typeof fixture>) =>
  f.cache.match.mock.calls.map(([req]) => new URL((req as Request).url).host).filter(host => host !== "as-visits.internal");

describe("serving I/O budgets", () => {
  it("uses a single content GET on a cold HTML route", async () => {
    const f = fixture({ "index.html": "<body>Home</body>" });
    expect(await (await f.request()).text()).toContain("Home");
    expect(f.bucket.get.mock.calls.filter(([key]) => key === prefix + "index.html")).toHaveLength(1);
    expect(f.bucket.head).not.toHaveBeenCalled();
    await f.settle();
  });

  it("authorizes before HTML 304s and invalidates validators on policy changes", async () => {
    const f = fixture({ "index.html": "<body>Home</body>" });
    const first = await f.request();
    const etag = first.headers.get("etag")!;
    await first.text();
    await f.settle();
    vi.clearAllMocks();
    const unchanged = await f.request("/", { "if-none-match": etag });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(f.bucket.get.mock.calls.map(([key]) => key)).toEqual(controlKeys);
    // The route, from where this location last left off; no body lookup.
    expect(lookups(f)).toEqual(["as-hints.internal", "as-routes.internal"]);
    f.meta.public = false;
    f.meta.accessKey = "secret";
    expect((await f.request("/", { "if-none-match": etag })).status).toBe(401);
    const authorized = await f.request("/", { "if-none-match": etag, cookie: "as_auth_docs=secret" });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("etag")).not.toBe(etag);
    await authorized.text();
    f.meta.tombstone = true;
    expect((await f.request("/", { "if-none-match": etag, cookie: "as_auth_docs=secret" })).status).toBe(410);
    await f.settle();
  });

  it("serves cold HEADs without loading a content body and honors static validators", async () => {
    const f = fixture({ "index.html": "<body>Home</body>", "app.css": "body{}" });
    const html = await f.request("/", undefined, "HEAD");
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("");
    expect(html.headers.get("etag")).toBeTruthy();
    const css = await f.request("/app.css", undefined, "HEAD");
    expect(css.headers.get("content-length")).toBe("6");
    expect(await css.text()).toBe("");
    expect((await f.request("/app.css", { "if-none-match": 'W/"fixture-etag"' }, "HEAD")).status).toBe(304);
    expect(f.bucket.get.mock.calls.every(([key]) => key === "_sites/u/docs" || key === prefix + "_meta")).toBe(true);
    await f.settle();
  });

  it("rebuilds the document index after publishing a different navigation tree", async () => {
    const f = fixture({ "README.md": "# Home", "old.md": "# Old" });
    await f.warm();
    f.objects.delete(prefix + "old.md");
    f.objects.set(prefix + "new.md", "# New");
    f.meta.generation = 2;
    const html = await (await f.request()).text();
    expect(html).toContain('href="/new.md"');
    expect(html).not.toContain('href="/old.md"');
    expect(f.bucket.list).toHaveBeenCalledOnce();
    await f.settle();
  });
  it.each<{ name: string; files: Record<string, string>; path: string }>([
    { name: "static asset", files: { "app.css": "body{}" }, path: "/app.css" },
    { name: "directory HTML", files: { "guide/index.html": "<body>Guide</body>" }, path: "/guide" },
    { name: "Markdown homepage", files: { "README.md": "# Home", "SUMMARY.md": "- [Home](README.md)" }, path: "/" },
  ])("reads one fresh merged record for a warm $name", async ({ files, path }) => {
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
    f.meta.generation = 2;
    expect(await (await f.request()).text()).toContain("New home");
    expect(f.bucket.get).toHaveBeenCalledWith(prefix + "index.html", undefined);
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
    expect(f.bucket.list).not.toHaveBeenCalled();
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

  it("does not cache missing routes", async () => {
    const f = fixture({});
    expect((await f.request("/new.css")).status).toBe(404);
    await f.settle();
    expect([...f.cacheEntries.keys()].filter(url => !url.startsWith("https://as-hints.internal/"))).toEqual([]);
    f.objects.set(prefix + "new.css", "body{}");
    expect(await (await f.request("/new.css")).text()).toBe("body{}");
    await f.settle();
  });

  // The share was last seen public here, so the cached page is already being
  // fetched when the record says otherwise. It is let go, not sent.
  it("honors a public-to-private change and takedown before sending any cached content", async () => {
    const f = fixture({ "index.html": "<body>Secret</body>" });
    await f.warm();
    const opened: { cancelled: boolean }[] = [];
    const original = f.cache.match.getMockImplementation()!;
    f.cache.match.mockImplementation(async req => {
      const hit = await original(req);
      if (!hit?.body || !req.url.startsWith("https://as-cache.internal/")) return hit;
      const state = { cancelled: false };
      opened.push(state);
      return new Response(new ReadableStream<Uint8Array>({ cancel() { state.cancelled = true; } }), hit);
    });
    f.meta.public = false;
    f.meta.accessKey = "new-key";
    const denied = await f.request();
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("Secret");
    f.meta.tombstone = true;
    const gone = await f.request();
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("Secret");
    await f.settle();
    expect(opened.map(o => o.cancelled)).toEqual([true]);
    // The record's answer is where the next request starts from: the second
    // one, with no key to offer, fetched nothing.
    expect(f.bucket.get.mock.calls.map(([key]) => key)).toEqual(["_sites/u/docs", "_sites/u/docs"]);
  });

  it("checks rotated keys on warm routes without caching reader credentials", async () => {
    const f = fixture({ "index.html": "<body>Secret</body>" });
    f.meta.public = false;
    f.meta.accessKey = "old-key";
    expect((await f.request("/", { cookie: "as_auth_docs=old-key" })).status).toBe(200);
    await f.settle();
    f.meta.accessKey = "new-key";
    expect((await f.request("/", { cookie: "as_auth_docs=old-key" })).status).toBe(401);
    expect((await f.request("/", { cookie: "as_auth_docs=new-key" })).status).toBe(200);
    const login = await f.request("/?k=new-key");
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("as_auth_docs=new-key");
    await login.text();
    await f.settle();
    for (const [key, response] of f.cacheEntries) {
      expect(key).not.toMatch(/old-key|new-key/);
      expect(await response.clone().text()).not.toMatch(/old-key|new-key/);
    }
  });
});

describe("opening a share link", () => {
  const cookie = "as_auth_docs=key; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000";
  const locked = (files: Record<string, string>) => {
    const f = fixture(files);
    f.meta.public = false;
    f.meta.accessKey = "key";
    return f;
  };

  it("logs the reader in on the page itself: one request, one record read", async () => {
    const f = locked({ "index.html": "<body>Home</body>" });
    const res = await f.request("/?k=key");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe(cookie);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(await res.text()).toContain("Home");
    await f.settle();
    expect(f.bucket.get.mock.calls.filter(([key]) => key === "_sites/u/docs")).toHaveLength(1);
    for (const [url, cached] of f.cacheEntries) {
      expect(url).not.toContain("key");
      expect(cached.headers.get("set-cookie")).toBeNull();
    }
  });

  it("gives a login the page even when the browser holds a matching validator", async () => {
    const f = locked({ "README.md": "# Home" });
    const first = await f.request("/", { cookie: "as_auth_docs=key" });
    const etag = first.headers.get("etag")!;
    await first.text();
    await f.settle();
    expect((await f.request("/", { cookie: "as_auth_docs=key", "if-none-match": etag })).status).toBe(304);
    const login = await f.request("/?k=key", { "if-none-match": etag });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toBe(cookie);
    expect(await login.text()).toContain('<h1 id="home">');
    await f.settle();
  });

  it("sets no cookie for a reader who already has one", async () => {
    const f = locked({ "index.html": "<body>Home</body>" });
    const res = await f.request("/?k=key", { cookie: "as_auth_docs=key" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.text();
    await f.settle();
  });

  // Only a page can drop the key from its own URL.
  it.each<{ name: string; path: string; method?: string; location: string }>([
    { name: "a static file", path: "/app.css?k=key", location: "/app.css" },
    { name: "a download", path: "/index.html?download&k=key", location: "/index.html?download=" },
    { name: "raw Markdown", path: "/notes.md?raw&k=key", location: "/notes.md?raw=" },
    { name: "a HEAD", path: "/?k=key", method: "HEAD", location: "/" },
    { name: "a missing path", path: "/nope?k=key", location: "/nope" },
  ])("still redirects $name", async ({ path, method, location }) => {
    const f = locked({ "index.html": "<body>Home</body>", "app.css": "body{}", "notes.md": "# Notes" });
    const res = await f.request(path, undefined, method);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(location);
    expect(res.headers.get("set-cookie")).toBe(cookie);
    expect(await res.text()).toBe("");
    await f.settle();
    expect(f.bucket.put).not.toHaveBeenCalled(); // not a visit yet
  });

  // The real rewriter runs in workerd; this checks what it is asked to do.
  describe("the key in the page's URL", () => {
    function rewritten(tags: string[]) {
      const inserted: string[] = [];
      vi.stubGlobal("HTMLRewriter", class {
        private handlers = new Map<string, { element(e: unknown): void }>();
        on(selector: string, handler: { element(e: unknown): void }) { this.handlers.set(selector, handler); return this; }
        transform(response: Response) {
          for (const tag of tags) {
            this.handlers.get(tag)?.element({
              prepend: (html: string) => inserted.push(`${tag}<${html}`),
              append: (html: string) => inserted.push(`${tag}>${html}`),
            });
          }
          return response;
        }
      });
      return inserted;
    }
    const strip = (inserted: string[]) => inserted.filter(i => i.includes("replaceState")).map(i => i.slice(0, 5));

    it.each<{ tags: string[]; at: string[] }>([
      { tags: ["head", "body"], at: ["head<"] },
      { tags: ["body"], at: ["body<"] },
    ])("is dropped once, as early as $tags allows", async ({ tags, at }) => {
      const f = locked({ "index.html": "<body>Home</body>" });
      const inserted = rewritten(tags);
      await (await f.request("/?k=key")).text();
      expect(strip(inserted)).toEqual(at);
      expect(inserted.at(-1)).toMatch(/^body>.*as-share/s);
      await f.settle();
    });

    it("is left alone when it is not the reader's key, or there is none", async () => {
      const f = locked({ "index.html": "<body>Home</body>" });
      const inserted = rewritten(["head", "body"]);
      await (await f.request("/?k=other", { cookie: "as_auth_docs=key" })).text();
      await (await f.request("/", { cookie: "as_auth_docs=key" })).text();
      expect(strip(inserted)).toEqual([]);
      await (await f.request("/?k=key", { cookie: "as_auth_docs=key" })).text();
      expect(strip(inserted)).toEqual(["head<"]);
      await f.settle();
    });
  });
});

describe("cold route lookups", () => {
  // A body whose cancellation is visible, in place of one file's.
  function watch(f: ReturnType<typeof fixture>, path: string) {
    const cancel = vi.fn();
    const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async (key, opts) => {
      const obj = await original(key, opts);
      return key === prefix + path && obj ? { ...obj, body: new ReadableStream<Uint8Array>({ cancel }) } : obj;
    });
    return cancel;
  }
  // Holds one file's read open until released.
  function hold(f: ReturnType<typeof fixture>, path: string) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async (key, opts) => {
      if (key === prefix + path) await gate;
      return original(key, opts);
    });
    return release;
  }
  const reads = (f: ReturnType<typeof fixture>) => f.bucket.get.mock.calls.map(([key]) => key).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));

  it("reads a Markdown home once, alongside the listing that names it", async () => {
    const f = fixture({ "README.md": "# Home", "next.md": "# Next" });
    const release = hold(f, "index.html");
    const serving = f.request();
    // Neither waits for the index.html miss.
    await vi.waitFor(() => {
      expect(reads(f)).toContain("README.md");
      expect(f.bucket.list).toHaveBeenCalledOnce();
    });
    release();
    const html = await (await serving).text();
    expect(html).toContain('<h1 id="home">');
    expect(html).toContain('href="/next.md"');
    expect(reads(f).sort()).toEqual(["README.md", "index.html"]);
    expect(f.bucket.list).toHaveBeenCalledOnce();
    await f.settle();
  });

  it("lets go of the README it fetched when the share has a page, or another home", async () => {
    const f = fixture({ "index.html": "<body>Page</body>", "README.md": "# Repo" });
    const dropped = watch(f, "README.md");
    expect(await (await f.request()).text()).toContain("Page");
    await f.settle();
    expect(dropped).toHaveBeenCalledOnce();

    const g = fixture({ "README.md": "# Repo", "intro.md": "# Intro", "SUMMARY.md": "- [Intro](intro.md)" });
    const unused = watch(g, "README.md");
    expect(await (await g.request()).text()).toContain('<h1 id="intro">');
    await g.settle();
    expect(unused).toHaveBeenCalledOnce();
  });

  it("does not fetch a README for requests that would not render it", async () => {
    const f = fixture({ "notes.md": "# Notes" });
    await (await f.request("/?raw")).text();
    expect(reads(f)).not.toContain("README.md");
    await f.settle();
    const g = fixture({ "notes.md": "# Notes" });
    expect((await g.request("/", undefined, "HEAD")).status).toBe(200);
    expect(reads(g)).toEqual([]);
    expect(g.bucket.head.mock.calls.map(([key]) => key)).toEqual([prefix + "index.html"]);
    await g.settle();
  });

  it("asks for an extensionless path and its directory index together", async () => {
    const f = fixture({ "guide/index.html": "<body>Guide</body>" });
    const release = hold(f, "guide");
    const serving = f.request("/guide");
    await vi.waitFor(() => expect(reads(f).sort()).toEqual(["guide", "guide/index.html"]));
    release();
    expect(await (await serving).text()).toContain("Guide");
    await f.settle();
  });

  it("serves the file itself when both exist, and lets go of the index", async () => {
    const f = fixture({ "LICENSE": "MIT", "LICENSE/index.html": "<body>Dir</body>" });
    const dropped = watch(f, "LICENSE/index.html");
    expect(await (await f.request("/LICENSE")).text()).toBe("MIT");
    await f.settle();
    expect(dropped).toHaveBeenCalledOnce();
  });

  it("probes one at a time when the name has an extension", async () => {
    const f = fixture({ "app.css": "body{}" });
    expect(await (await f.request("/app.css")).text()).toBe("body{}");
    expect((await f.request("/gone.css")).status).toBe(404);
    expect(reads(f)).toEqual(["app.css", "gone.css", "gone.css/index.html", "404.html"]);
    await f.settle();
  });

  it.each(["/", "/app.css"])("serves %s from the object it resolved, without asking the body cache", async path => {
    const f = fixture({ "index.html": "<body>Home</body>", "app.css": "body{}" });
    const res = await f.request(path);
    expect(res.status).toBe(200);
    await res.text();
    await f.settle();
    expect(f.cache.match.mock.calls.map(([req]) => (req as Request).url).filter(url => url.startsWith("https://as-cache.internal/"))).toEqual([]);
    // …and the next request finds it there.
    vi.clearAllMocks();
    await (await f.request(path)).text();
    expect(reads(f)).toEqual([]);
    await f.settle();
  });
});

describe("work started while the record is read", () => {
  // Holds the share record back until released; everything else answers at once.
  function holdRecord(f: ReturnType<typeof fixture>) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async (key, opts) => {
      if (key === "_sites/u/docs") await gate;
      return original(key, opts);
    });
    return release;
  }
  const contentReads = (f: ReturnType<typeof fixture>) => f.bucket.get.mock.calls.map(([key]) => key).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  const stored = (f: ReturnType<typeof fixture>) => [...f.cacheEntries.keys()].filter(url => !url.startsWith("https://as-hints.internal/") && !url.startsWith("https://as-visits.internal/"));
  const locked = (files: Record<string, string>) => {
    const f = fixture(files);
    f.meta.public = false;
    f.meta.accessKey = "key";
    return f;
  };

  it.each<{ name: string; files: Record<string, string>; path: string; reads: string[] }>([
    { name: "an HTML page", files: { "index.html": "<body>Home</body>" }, path: "/?k=key", reads: ["README.md", "index.html"] },
    { name: "a Markdown home", files: { "README.md": "# Home" }, path: "/?k=key", reads: ["README.md", "index.html"] },
    { name: "an asset", files: { "app.css": "body{}" }, path: "/app.css", reads: ["app.css"] },
  ])("reads $name from R2 alongside the record on a first visit with a key", async ({ files, path, reads }) => {
    const f = locked(files);
    const release = holdRecord(f);
    const serving = f.request(path, { cookie: path.includes("k=") ? "" : "as_auth_docs=key" });
    // The content is on its way before the record has answered.
    await vi.waitFor(() => expect(contentReads(f).sort()).toEqual(reads));
    expect(lookups(f)).toEqual(["as-hints.internal"]);
    release();
    const res = await serving;
    expect(res.status).toBe(200);
    await res.text();
    await f.settle();
    // Each file was read once, and the route is cached under the record's generation.
    expect(contentReads(f).sort()).toEqual(reads);
    expect(stored(f).some(url => url.startsWith("https://as-routes.internal/u/docs/g1/"))).toBe(true);
  });

  it("asks the caches alongside the record once this location knows the share", async () => {
    const f = locked({ "index.html": "<body>Home</body>" });
    await (await f.request("/", { cookie: "as_auth_docs=key" })).text();
    await f.settle();
    vi.clearAllMocks();
    const release = holdRecord(f);
    const serving = f.request("/", { cookie: "as_auth_docs=key" });
    await vi.waitFor(() => expect(lookups(f)).toEqual(["as-hints.internal", "as-routes.internal", "as-cache.internal"]));
    release();
    expect(await (await serving).text()).toContain("Home");
    await f.settle();
    // No second lookup for what was already fetched, and no file read at all.
    expect(lookups(f)).toEqual(["as-hints.internal", "as-routes.internal", "as-cache.internal"]);
    expect(contentReads(f)).toEqual([]);
  });

  it("starts nothing for a request with no key to a share not known to be public", async () => {
    const f = locked({ "index.html": "<body>Secret</body>" });
    expect((await f.request()).status).toBe(401);
    expect((await f.request("/app.css")).status).toBe(401);
    await f.settle();
    expect(contentReads(f)).toEqual([]);
    expect(lookups(f)).toEqual(["as-hints.internal", "as-hints.internal"]);
    // …nor for a share that does not exist.
    const g = fixture({});
    g.bucket.get.mockImplementation(async () => null);
    expect((await g.request("/", { cookie: "as_auth_docs=anything" })).status).toBe(404);
    await g.settle();
    expect(stored(g)).toEqual([]);
  });

  it("lets go of what it read, and stores none of it, when the key is wrong", async () => {
    const f = locked({ "index.html": "<body>Secret</body>", "README.md": "# Secret" });
    const cancelled: string[] = [];
    const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async (key, opts) => {
      const obj = await original(key, opts);
      return obj && key.startsWith(prefix) ? { ...obj, body: new ReadableStream<Uint8Array>({ cancel() { cancelled.push(key.slice(prefix.length)); } }) } : obj;
    });
    const res = await f.request("/", { cookie: "as_auth_docs=stale" });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("Secret");
    await f.settle();
    expect(cancelled.sort()).toEqual(["README.md", "index.html"]);
    expect(stored(f)).toEqual([]);
  });

  it("keeps a file read from R2 when the generation it guessed was wrong, and caches it under the right one", async () => {
    const f = fixture({ "index.html": "<body>Home</body>", "app.css": "body{}" });
    await f.warm(); // this location now expects generation 1
    f.objects.set(prefix + "app.css", "body{color:red}");
    f.meta.generation = 2;
    expect(await (await f.request("/app.css")).text()).toBe("body{color:red}");
    await f.settle();
    expect(contentReads(f)).toEqual(["app.css"]);
    expect(stored(f).filter(url => url.includes("app.css")).sort()).toEqual([
      "https://as-cache.internal/u/docs/g2/app.css",
      "https://as-routes.internal/u/docs/g2/r5/app.css",
    ]);
  });

  it("sets aside what the caches said under an outdated generation", async () => {
    const f = fixture({ "app.css": "body{}" });
    await f.warm("/app.css");
    f.objects.set(prefix + "app.css", "body{color:red}");
    f.meta.generation = 2;
    expect(await (await f.request("/app.css")).text()).toBe("body{color:red}");
    await f.settle();
    // The next request starts from generation 2.
    vi.clearAllMocks();
    expect(await (await f.request("/app.css")).text()).toBe("body{color:red}");
    expect(contentReads(f)).toEqual([]);
    await f.settle();
  });

  it("answers from the record alone when starting early fails", async () => {
    const f = locked({ "index.html": "<body>Home</body>" });
    const original = f.bucket.get.getMockImplementation()!;
    let failed = false;
    f.bucket.get.mockImplementation(async (key, opts) => {
      if (key === prefix + "index.html" && !failed) {
        failed = true;
        throw new Error("R2 hiccup");
      }
      return original(key, opts);
    });
    const res = await f.request("/", { cookie: "as_auth_docs=key" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Home");
    await f.settle();
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
    expect(response!.headers.get("cache-control")).toBe("private, no-cache");
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

describe("shares without a page of their own", () => {
  it("previews a single file at / and lists several", async () => {
    const f = fixture({ "demo.mp4": "data" });
    const single = await (await f.request()).text();
    expect(single).toContain('<video class="preview" src="/demo.mp4"');
    expect(single).toContain('href="/demo.mp4?download"');
    await f.settle();

    const g = fixture({ "a b.csv": "1,2", "data/b.csv": "3,4", "late.bin": "x" });
    g.meta.pending = { "late.bin": { bytes: 1, expiresAt: 0 } };
    const list = await (await g.request()).text();
    expect(list).toContain('href="/a%20b.csv"');
    expect(list).toContain('href="/data/b.csv?download"');
    // An upload not yet completed isn't part of the share.
    expect(list).not.toContain("late.bin");
    await g.settle();
  });

  it("serves the stored type, falling back to the extension when an upload stored none", async () => {
    const f = fixture(
      { "forced.mp4": "data", "none.mp4": "data", "generic.mp4": "data" },
      { "forced.mp4": "video/webm", "generic.mp4": "application/octet-stream" },
    );
    for (const [path, type] of [["forced.mp4", "video/webm"], ["none.mp4", "video/mp4"], ["generic.mp4", "video/mp4"]]) {
      expect((await f.request(`/${path}`)).headers.get("content-type")).toBe(type);
      await f.settle();
      // Same answer from the edge cache.
      expect((await f.request(`/${path}`)).headers.get("content-type")).toBe(type);
      await f.settle();
    }
  });

  it("lists files on a site that only lacks an index.html", async () => {
    const f = fixture({ "about.html": "<p>about</p>", "app.css": "body{}" });
    const res = await f.request();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/about.html"');
    await f.settle();
  });

  it("hands over the file itself on ?download, HTML and Markdown included", async () => {
    const f = fixture({ "dir/Relatório final.pdf": "%PDF", "index.html": "<body>Home</body>", "README.md": "# Hi" });
    const pdf = await f.request("/dir/Relat%C3%B3rio%20final.pdf?download");
    expect(pdf.headers.get("content-disposition")).toBe(`attachment; filename="Relatorio final.pdf"; filename*=UTF-8''Relat%C3%B3rio%20final.pdf`);
    expect(await pdf.text()).toBe("%PDF");
    const html = await f.request("/index.html?download");
    expect(html.headers.get("content-disposition")).toContain('filename="index.html"');
    expect(await html.text()).toBe("<body>Home</body>");
    const md = await f.request("/README.md?download");
    expect(await md.text()).toBe("# Hi");
    await f.settle();
    // The cached copy carries no per-request disposition.
    const cached = await f.request("/dir/Relat%C3%B3rio%20final.pdf");
    expect(cached.headers.get("content-disposition")).toBeNull();
    await f.settle();
  });

  it("streams files too large for the Cache API without storing them", async () => {
    const f = fixture({ "big.bin": "x" });
    const original = f.bucket.get.getMockImplementation()!;
    f.bucket.get.mockImplementation(async (key, opts) => {
      const obj = await original(key, opts);
      return key === prefix + "big.bin" && obj ? { ...obj, size: CACHE_MAX_BYTES + 1 } : obj;
    });
    expect(await (await f.request("/big.bin")).text()).toBe("x");
    await f.settle();
    expect(f.cache.put.mock.calls.map(([req]) => (req as Request).url).filter(u => u.includes("as-cache"))).toEqual([]);
  });

  it("still admits readers holding a key minted before keys were stored", async () => {
    const f = fixture({ "index.html": "<body>Old link</body>" });
    f.meta.public = false;
    f.meta.keyHash = await sha256Hex("legacy");
    expect((await f.request()).status).toBe(401);
    const login = await f.request("/?k=legacy");
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("as_auth_docs=legacy");
    expect((await f.request("/", { cookie: "as_auth_docs=legacy" })).status).toBe(200);
    await f.settle();
  });
});

describe("visits", () => {
  it("records a served visit once a day, and never a denied or missing one", async () => {
    // A fresh module: the isolate's memory of today's visits is per process.
    vi.resetModules();
    const { handleSite: serve } = await import("../src/serve");
    const f = fixture({ "index.html": "<body>Home</body>" });
    f.meta.public = false;
    f.meta.accessKey = "key";
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const env = { SITES: f.bucket, APEX_HOST: "example.com" } as unknown as Env;
    const request = async (path: string, headers?: HeadersInit) => {
      await (await serve(new Request("https://u-docs.example.com" + path, { headers }), env, ctx, "u", "docs", "u-docs.example.com")).text();
      await Promise.all(pending.splice(0));
    };
    await request("/");
    await request("/missing.css", { cookie: "as_auth_docs=key" });
    expect(f.bucket.put).not.toHaveBeenCalled();
    await request("/", { cookie: "as_auth_docs=key" });
    expect(f.bucket.put).toHaveBeenCalledWith("_visits/u/docs", "");
    await request("/", { cookie: "as_auth_docs=key" });
    expect(f.bucket.put).toHaveBeenCalledOnce();
  });
});
