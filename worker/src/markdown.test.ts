import { describe, expect, it } from "vitest";
import { docHref, parseSummary, renderDoc } from "./markdown";

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
    expect(plain).toContain('<pre><code class="language-js">');
  });

  it("escapes the site id and the title it puts in <title>", () => {
    const html = renderDoc('ev"il', "a.md", "# <script>alert(1)</script>", index(["a.md"]));
    expect(html).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt; · ev&quot;il</title>");
  });
});
