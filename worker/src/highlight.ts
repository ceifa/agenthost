// Syntax highlighting at render time: highlight.js core plus a curated language
// set. Server-side because the render is cached per deploy — the reader pays
// nothing, and the page needs no script and no CDN to be complete.
//
// Only *declared* languages are highlighted. Auto-detection is a coin flip on
// short snippets and costs CPU on every fence, so an unlabelled block stays
// plain text, which is what it actually is.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Each definition brings its own aliases (sh, yml, ts, py, html, …), so the
// fences people actually write resolve without a lookup table here.
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  nginx,
  php,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

// Returns highlighted HTML, or null when we don't know the language — the caller
// then falls back to marked's plain, escaped code block.
export function highlightCode(code: string, language: string): string | null {
  if (!language || !hljs.getLanguage(language)) return null;
  // ignoreIllegals: a doc snippet is often a fragment, and a strict parse error
  // should downgrade the colors, never throw on the page.
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

// The canonical name for a resolved alias ("yml" → "yaml"), for the class we put
// on <code> and for the label on the block.
export function languageName(language: string): string | null {
  return hljs.getLanguage(language)?.name?.toLowerCase() ?? null;
}
