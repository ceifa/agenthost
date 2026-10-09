import { describe, expect, it, vi } from "vitest";
import { docHref, parseSummary, renderDoc, readMarkdownSource } from "./markdown";
import { RENDER_LIMITS } from "./config";

const index = (files: string[], nav: ReturnType<typeof parseSummary> | null = null) => ({ files, nav });

describe("doc links", () => {
  // Regression: the shell used to ship <base href="/"> so its site-root-relative
  // sidebar links would work from a nested page — which silently re-based every
  // relative link *inside* a nested document to the site root.
  it("keeps a nested page's relative links relative", () => {
    const html = renderDoc("docs", "guide/intro.md", "# Intro\n\nSee [the API](./api.md).", index(["guide/intro.md", "guide/api.md"]));

    expect(html).not.toContain("<base");
    expect(html).toContain('href="./api.md"');
  });

  it("points the sidebar at root-absolute, encoded paths", () => {
    const html = renderDoc("docs", "guide/intro.md", "# Intro", index(["guide/intro.md", "guide/plano de voo.md"]));

    expect(html).toContain('href="/guide/intro.md" class="active"');
    expect(html).toContain('href="/guide/plano%20de%20voo.md"');
    expect(docHref("a/b c.md")).toBe("/a/b%20c.md");
  });
});

describe("SUMMARY.md", () => {
  it("uses filename navigation when a SUMMARY exceeds the rendering budget", () => {
    expect(parseSummary("- [Home](README.md)\n" + "x".repeat(RENDER_LIMITS.documentChars))).toEqual([]);
  });
  it("keeps list indentation as nav depth", () => {
    const nav = parseSummary(`# Summary

- [Home](README.md)
- [Guide](guide/index.md)
  - [Install](guide/install.md)
    - [Docker](guide/docker.md)
- [API](api.md)
`);

    expect(nav.map((n) => [n.href, n.depth])).toEqual([
      ["README.md", 0],
      ["guide/index.md", 0],
      ["guide/install.md", 1],
      ["guide/docker.md", 2],
      ["api.md", 0],
    ]);
  });

  it("ignores non-markdown links and keeps its own ordering", () => {
    const nav = parseSummary("* [Site](https://example.com)\n* [Second](b.md)\n* [First](a.md)\n");
    expect(nav.map((n) => n.href)).toEqual(["b.md", "a.md"]);

    const html = renderDoc("docs", "a.md", "# A", index(["a.md", "b.md", "SUMMARY.md"], nav));
    expect(html.indexOf("/b.md")).toBeLessThan(html.indexOf("/a.md"));
    expect(html).not.toContain("SUMMARY.md"); // the nav source is not a page
  });
});

describe("rendered document", () => {
  it("bounds highlighting per block and across the document, retaining escaped code", () => {
    const code = "const x = '<tag>';\n".repeat(90);
    const fence = "```js\n" + code + "```\n";
    const html = renderDoc("docs", "a.md", fence.repeat(4), index(["a.md"]));
    expect(html.match(/<code class="hljs">/g)).toHaveLength(2);
    expect(html).toContain(`<code class="language-js">const x = '&lt;tag&gt;'`);
    const large = renderDoc("docs", "a.md", "```js\n" + "const x = 1;\n".repeat(200) + "```", index(["a.md"]));
    expect(large).not.toContain('<code class="hljs">');
    expect(large).toContain("const x = 1;");
  });

  it("shows oversized documents as escaped text instead of parsing Markdown", () => {
    const source = "# Large\n<script>evil()</script>\n" + "x".repeat(RENDER_LIMITS.documentChars) + "tail-marker";
    const html = renderDoc("docs", "a.md", source, index(["a.md"]));
    expect(html).not.toContain('<h1 id="large">');
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
    expect(html).toContain("# Large");
    expect(html).not.toContain("tail-marker");
    expect(html).toContain('href="/a.md?raw">Open the complete source</a>');
  });

  it("stops reading oversized R2 bodies and preserves UTF-8 across chunks", async () => {
    const cancel = vi.fn();
    const large = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(RENDER_LIMITS.documentChars + 1))); }, cancel });
    expect((await readMarkdownSource({ body: large } as R2ObjectBody)).length).toBe(RENDER_LIMITS.documentChars + 1);
    expect(cancel).toHaveBeenCalledOnce();
    const bytes = new TextEncoder().encode("# Olá 👋");
    const utf8 = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    expect(await readMarkdownSource({ body: utf8 } as R2ObjectBody)).toBe("# Olá 👋");
  });
  const doc = `# Report

## Situação atual
Body.

### Detalhe
More.

## Situação atual
Same heading twice.

## Fim
`;

  it("gives headings deep-linkable ids and an outline", () => {
    const html = renderDoc("docs", "README.md", doc, index(["README.md"]));

    expect(html).toContain('<h2 id="situacao-atual">');
    expect(html).toContain('<h2 id="situacao-atual-1">'); // duplicates stay unique
    expect(html).toContain('<h1 id="report">Report</h1>'); // no self-link on the title
    expect(html).toContain('<div class="layout has-toc">');
    expect(html).toContain('<aside class="toc">');
    expect(html).toContain('<a href="#detalhe">');
  });

  it("skips the outline when there is barely an outline", () => {
    const html = renderDoc("docs", "README.md", "# Report\n\n## Only one\n", index(["README.md"]));
    expect(html).not.toContain('<aside class="toc">');
    expect(html).toContain('<div class="layout">');
  });

  it("links the neighbouring pages, and only the ones that exist", () => {
    const files = ["a.md", "b.md", "c.md"];
    const middle = renderDoc("docs", "b.md", "# B", index(files));
    expect(middle).toContain('class="prev" href="/a.md"');
    expect(middle).toContain('class="next" href="/c.md"');

    const last = renderDoc("docs", "c.md", "# C", index(files));
    expect(last).toContain('class="prev" href="/b.md"');
    expect(last).not.toContain('class="next"');
  });

  it("renders mermaid fences as diagram blocks and loads the runtime only then", () => {
    const withDiagram = renderDoc("docs", "a.md", "# A\n\n```mermaid\ngraph TD;\nA-->B;\n```\n", index(["a.md"]));
    expect(withDiagram).toContain('<pre class="mermaid">graph TD;');
    expect(withDiagram).toContain("mermaid.esm.min.mjs");

    const plain = renderDoc("docs", "a.md", "# A\n\n```js\nvar a;\n```\n", index(["a.md"]));
    expect(plain).not.toContain("mermaid.esm.min.mjs");
  });

  // Regression: the copy button and the language label used to be positioned
  // against the <pre> — which is the horizontal scroll container, so both slid
  // away with the code. They now anchor to a non-scrolling wrapper.
  it("wraps every code block in a non-scrolling positioning context", () => {
    const html = renderDoc("docs", "a.md", "# A\n\n```js\nconst x = 1;\n```\n\n```\nplain\n```\n", index(["a.md"]));

    expect(html).toContain('<div class="codeblock" data-lang="javascript"><pre><code class="hljs">');
    expect(html).toContain('<div class="codeblock"><pre><code>plain');
    expect(html).not.toContain("<pre data-lang=");
  });

  it("highlights declared languages, through their aliases", () => {
    const html = renderDoc("docs", "a.md", "# A\n\n```js\nconst x = 1; // hi\n```\n", index(["a.md"]));
    expect(html).toContain('<code class="hljs">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-comment">// hi</span>');

    const yml = renderDoc("docs", "a.md", "# A\n\n```yml\nkey: value\n```\n", index(["a.md"]));
    expect(yml).toContain('data-lang="yaml"');
  });

  it("leaves unknown and unlabelled blocks as plain code", () => {
    const unknown = renderDoc("docs", "a.md", "# A\n\n```brainfuck\n+++.\n```\n", index(["a.md"]));
    expect(unknown).toContain('<pre><code class="language-brainfuck">+++.');
    expect(unknown).not.toContain('<code class="hljs">');
    expect(unknown).toContain('<div class="codeblock"><pre>'); // no label we can trust

    const bare = renderDoc("docs", "a.md", "# A\n\n```\nplain\n```\n", index(["a.md"]));
    expect(bare).toContain("<pre><code>plain");
  });

  it("escapes markup inside a highlighted block", () => {
    const html = renderDoc("docs", "a.md", "# A\n\n```html\n<script>alert(1)</script>\n```\n", index(["a.md"]));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;");
  });

  it("ships the markdown source alongside the render, escaped", () => {
    const source = "# A\n\n<script>alert(1)</script>\n\n- item & \"quote\"\n";
    const html = renderDoc("docs", "a.md", source, index(["a.md"]));

    expect(html).toContain('<label class="act" for="raw">');
    expect(html).toContain(
      '<pre class="raw" id="raw-src"># A\n\n&lt;script&gt;alert(1)&lt;/script&gt;\n\n- item &amp; &quot;quote&quot;\n</pre>',
    );
  });

  it("escapes the site id and the title it puts in <title>", () => {
    const html = renderDoc('ev"il', "a.md", "# <script>alert(1)</script>", index(["a.md"]));
    expect(html).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt; · ev&quot;il</title>");
  });
});
