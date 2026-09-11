// Server-side markdown → GitBook-style HTML (sidebar nav + rendered content).

import { Marked } from "marked";
import { markdownShell, esc } from "./templates";
import { highlightCode, languageName } from "./highlight";
import { listAll, sitePrefix } from "./storage";
import type { Env } from "./env";

const usesMermaid = (md: string) => /```\s*mermaid/i.test(md);

function titleFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Docs live at site-root-relative paths ("guide/intro.md"); links to them must be
// root-absolute so they work from any depth *without* a <base> tag — which would
// otherwise break relative links written inside a nested document.
export function docHref(path: string): string {
  return "/" + path.split("/").map(encodeURIComponent).join("/");
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// GitHub-ish slugs, deduped per document so repeated headings still deep-link.
function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // drop the accents NFD just split off
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

interface Heading {
  id: string;
  title: string;
  depth: number;
}

// A fresh parser per render: the heading renderer carries per-document state
// (slug dedupe, the collected outline), so a shared instance would leak it.
function createParser(headings: Heading[]) {
  const seen = new Map<string, number>();
  const parser = new Marked({ gfm: true, breaks: false });
  parser.use({
    renderer: {
      // ```mermaid becomes <pre class="mermaid"> for the client-side runtime the
      // shell loads; a known language gets highlighted here, at render time;
      // anything else falls through to marked's plain escaped block.
      code({ text, lang }) {
        const language = (lang ?? "").trim().split(/\s+/)[0]!;
        if (language === "mermaid") return `<pre class="mermaid">${esc(text)}</pre>`;
        const highlighted = highlightCode(text, language);
        if (highlighted === null) return false;
        return `<pre data-lang="${esc(languageName(language) ?? language)}"><code class="hljs">${highlighted}</code></pre>\n`;
      },
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const title = plainText(html);
        const id = slugify(title, seen);
        if (depth >= 2 && depth <= 3) headings.push({ id, title, depth });
        // h1 is the page title — no self-link, it would only add noise.
        const anchor = depth === 1 ? "" : `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`;
        return `<h${depth} id="${id}">${html}${anchor}</h${depth}>\n`;
      },
    },
  });
  return parser;
}

async function listMarkdown(env: Env, username: string, siteId: string): Promise<string[]> {
  const prefix = sitePrefix(username, siteId);
  const objs = await listAll(env.SITES, prefix);
  return objs
    .map((o) => o.key.slice(prefix.length))
    .filter((p) => /\.md$/i.test(p) && !p.startsWith("_"))
    .sort();
}

interface NavEntry {
  href: string;
  title: string;
  depth: number; // nesting level from SUMMARY.md indentation
}

const isSummary = (p: string) => /(^|\/)SUMMARY\.md$/i.test(p);

// SUMMARY.md (GitBook convention) defines nav order, titles and — through list
// indentation — the nav hierarchy.
export function parseSummary(summary: string): NavEntry[] {
  const out: NavEntry[] = [];
  const levels: number[] = []; // indent columns seen so far, ascending
  for (const line of summary.split(/\r?\n/)) {
    const m = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?\[([^\]]*)\]\(([^)]+)\)/.exec(line);
    if (!m) continue;
    const href = m[3]!.trim().replace(/^\.?\//, "").split("#")[0]!;
    if (!/\.md$/i.test(href)) continue;
    const indent = m[1]!.replace(/\t/g, "    ").length;
    while (levels.length && levels[levels.length - 1]! > indent) levels.pop();
    if (!levels.length || levels[levels.length - 1]! < indent) levels.push(indent);
    out.push({ href, title: m[2]!.trim() || titleFromPath(href), depth: Math.min(levels.length - 1, 2) });
  }
  return out;
}

// Nav order: SUMMARY entries first (in its order), then any .md it forgot.
function navEntries(files: string[], nav: NavEntry[] | null): NavEntry[] {
  const pages = files.filter((f) => !isSummary(f)); // SUMMARY defines the nav, it isn't a page
  if (!nav?.length) return pages.map((p) => ({ href: p, title: titleFromPath(p), depth: 0 }));
  const listed = new Set(nav.map((n) => n.href));
  return [
    ...nav.filter((n) => pages.includes(n.href)),
    ...pages.filter((p) => !listed.has(p)).map((p) => ({ href: p, title: titleFromPath(p), depth: 0 })),
  ];
}

function renderSidebar(entries: NavEntry[], current: string): string {
  const items = entries
    .map(
      (e) =>
        `<li class="d${e.depth}"><a href="${esc(docHref(e.href))}"${e.href === current ? ' class="active" aria-current="page"' : ""}>${esc(e.title)}</a></li>`,
    )
    .join("");
  return `<ul>${items}</ul>`;
}

// "On this page" — only earns its column when there is something to navigate.
function renderToc(headings: Heading[]): string {
  if (headings.length < 3) return "";
  const items = headings
    .map((h) => `<li class="h${h.depth}"><a href="#${esc(h.id)}">${esc(h.title)}</a></li>`)
    .join("");
  return `<ul>${items}</ul>`;
}

function renderPager(entries: NavEntry[], current: string): string {
  const i = entries.findIndex((e) => e.href === current);
  if (i === -1) return "";
  const prev = entries[i - 1];
  const next = entries[i + 1];
  if (!prev && !next) return "";
  const link = (e: NavEntry, rel: "prev" | "next") =>
    `<a class="${rel}" href="${esc(docHref(e.href))}" rel="${rel}"><span>${rel === "prev" ? "Previous" : "Next"}</span>${esc(e.title)}</a>`;
  return `${prev ? link(prev, "prev") : "<span></span>"}${next ? link(next, "next") : ""}`;
}

async function loadSummaryNav(env: Env, username: string, siteId: string, files: string[]): Promise<NavEntry[] | null> {
  const summaryFile = files.find(isSummary);
  if (!summaryFile) return null;
  const obj = await env.SITES.get(sitePrefix(username, siteId) + summaryFile);
  return obj ? parseSummary(await obj.text()) : null;
}

// The site's .md listing + SUMMARY nav — loaded once per render and shareable
// across resolveTarget/renderMarkdown so a request never lists twice.
export interface DocIndex {
  files: string[];
  nav: NavEntry[] | null;
}

export async function loadDocIndex(env: Env, username: string, siteId: string): Promise<DocIndex> {
  const files = await listMarkdown(env, username, siteId);
  const nav = await loadSummaryNav(env, username, siteId, files);
  return { files, nav };
}

// Pure part of the render, so it can be exercised without R2.
export function renderDoc(siteId: string, mdPath: string, source: string, index: DocIndex): string {
  const headings: Heading[] = [];
  const contentHtml = createParser(headings).parse(source, { async: false });
  const entries = navEntries(index.files, index.nav);

  const h1 = source.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1]!.trim() : titleFromPath(mdPath);

  return markdownShell({
    siteId,
    title,
    contentHtml,
    sidebarHtml: renderSidebar(entries, mdPath),
    tocHtml: renderToc(headings),
    pagerHtml: renderPager(entries, mdPath),
    mermaid: usesMermaid(source),
  });
}

export async function renderMarkdown(
  env: Env,
  username: string,
  siteId: string,
  mdPath: string,
  source: string,
  index?: DocIndex,
): Promise<string> {
  return renderDoc(siteId, mdPath, source, index ?? (await loadDocIndex(env, username, siteId)));
}

// The doc shown at `/` for a markdown-only site: first SUMMARY entry, else README.
export async function defaultMarkdownDoc(
  env: Env,
  username: string,
  siteId: string,
): Promise<{ path: string; index: DocIndex } | null> {
  const index = await loadDocIndex(env, username, siteId);
  const { files, nav } = index;
  if (!files.length) return null;
  const first = nav?.find((n) => files.includes(n.href));
  const path = first?.href ?? files.find((f) => /^readme\.md$/i.test(f)) ?? files.find((f) => !isSummary(f)) ?? files[0]!;
  return { path, index };
}
