// Server-side markdown → GitBook-style HTML (sidebar nav + rendered content).

import { marked } from "marked";
import { markdownShell, esc } from "./templates";
import { listAll, sitePrefix } from "./storage";
import type { Env } from "./env";

// GFM on; ```mermaid fenced blocks become <pre class="mermaid"> so the mermaid
// runtime (loaded in the shell) renders them as diagrams client-side.
marked.setOptions({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0];
      if (language === "mermaid") return `<pre class="mermaid">${esc(text)}</pre>`;
      return false; // fall through to marked's default code renderer
    },
  },
});

const usesMermaid = (md: string) => /```\s*mermaid/i.test(md);

function titleFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
}

const isSummary = (p: string) => /(^|\/)SUMMARY\.md$/i.test(p);

// SUMMARY.md (GitBook convention) defines nav order + titles via markdown links.
function parseSummary(summary: string): NavEntry[] {
  const out: NavEntry[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary))) {
    const href = m[2]!.trim().replace(/^\.?\//, "").split("#")[0]!;
    if (/\.md$/i.test(href)) out.push({ href, title: m[1]!.trim() || titleFromPath(href) });
  }
  return out;
}

function buildSidebar(files: string[], nav: NavEntry[] | null, current: string): string {
  // Pages = all .md except SUMMARY.md itself (it defines the nav, isn't a page).
  const pages = files.filter((f) => !isSummary(f));
  let entries: NavEntry[];
  if (nav && nav.length) {
    const listed = new Set(nav.map((n) => n.href));
    entries = [
      ...nav.filter((n) => pages.includes(n.href)),
      ...pages.filter((p) => !listed.has(p)).map((p) => ({ href: p, title: titleFromPath(p) })),
    ];
  } else {
    entries = pages.map((p) => ({ href: p, title: titleFromPath(p) }));
  }
  const items = entries
    .map((e) => `<li><a href="${esc(e.href)}"${e.href === current ? ' class="active"' : ""}>${esc(e.title)}</a></li>`)
    .join("");
  return `<ul>${items}</ul>`;
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

// Renders into the GitBook shell. The per-request Share widget is injected later
// by the serve path, so the cached render holds no access key.
export async function renderMarkdown(
  env: Env,
  username: string,
  siteId: string,
  mdPath: string,
  source: string,
  index?: DocIndex,
): Promise<string> {
  const { files, nav } = index ?? (await loadDocIndex(env, username, siteId));

  const contentHtml = await marked.parse(source);
  const sidebarHtml = buildSidebar(files, nav, mdPath);

  const h1 = source.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1]!.trim() : titleFromPath(mdPath);

  return markdownShell({ siteId, title, contentHtml, sidebarHtml, mermaid: usesMermaid(source) });
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
