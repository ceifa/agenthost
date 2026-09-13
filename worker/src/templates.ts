// Branded HTML the Worker generates: interstitial, share widget, markdown shell, 404.

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SHELL_CSS = `
:root{--bg:#0c0d0f;--fg:#e9e7e2;--muted:#83868c;--accent:#f2b544;--card:#141518;--border:#23252a}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
`;

export function interstitialHtml(opts: { siteId: string; apexHost: string; wrong?: boolean }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Private site · agenthost</title>
<style>${SHELL_CSS}
.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}
h1{font-size:18px;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px;font-size:14px}
form{display:flex;gap:8px}
input{flex:1;background:#0c0d0f;border:1px solid var(--border);color:var(--fg);border-radius:9px;padding:11px 12px;font-size:15px}
input:focus{outline:2px solid var(--accent);border-color:transparent}
button{background:var(--accent);color:#0c0d0f;border:0;border-radius:9px;padding:0 16px;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin-top:12px}.brand{font-size:12px;color:var(--muted);margin-top:18px;text-align:center}
</style></head><body><div class="wrap"><div class="card">
<h1>🔒 This site is private</h1>
<p>Enter the access key to continue.</p>
<form method="GET" action="">
<input name="k" type="text" autocomplete="off" autofocus placeholder="access key" aria-label="access key">
<button type="submit">Enter</button>
</form>
${opts.wrong ? '<div class="err">Incorrect key — try again.</div>' : ""}
<div class="brand">hosted on <a href="https://${esc(opts.apexHost)}">${esc(opts.apexHost)}</a></div>
</div></div></body></html>`;
}

export function shareWidget(shareUrl: string): string {
  const safe = JSON.stringify(shareUrl);
  return `<div id="as-share" style="position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<button id="as-share-btn" style="display:flex;align-items:center;gap:7px;background:#16181c;color:#e9e7e2;border:1px solid #32343a;border-radius:999px;padding:9px 15px;font-weight:500;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28)">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
<span id="as-share-label">Share</span></button></div>
<script>(function(){var u=${safe};var b=document.getElementById('as-share-btn'),l=document.getElementById('as-share-label');b.addEventListener('click',function(){var done=function(){l.textContent='Copied!';setTimeout(function(){l.textContent='Share'},1500)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done).catch(function(){prompt('Copy this link:',u)})}else{prompt('Copy this link:',u)}})})();</script>`;
}

// Docs shell: prose in a sans measure of ~82ch, chrome and code in mono, one
// amber accent — the landing's palette, adapted to both color schemes.
const DOC_CSS = `
:root{color-scheme:light dark;--measure:82ch;
--bg:#fbfaf8;--fg:#16181c;--dim:#5f636b;--line:#e4e1dc;--card:#f2f0ec;--accent:#8a5300;--sel:rgba(138,83,0,.13);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--add:#1b6b3a;--del:#a32b2b;
/* VS Code Light+ token colors */
--t-comment:#008000;--t-keyword:#0000ff;--t-type:#267f99;--t-function:#795e26;--t-string:#a31515;
--t-number:#098658;--t-variable:#001080;--t-tag:#800000;--t-regexp:#811f3f;--t-meta:#0000ff;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0c0d0f;--fg:#e9e7e2;--dim:#83868c;--line:#23252a;--card:#141518;--accent:#f2b544;--sel:rgba(242,181,68,.18);--add:#7bc98e;--del:#f08a8a;/* VS Code Dark+ */--t-comment:#6a9955;--t-keyword:#569cd6;--t-type:#4ec9b0;--t-function:#dcdcaa;--t-string:#ce9178;--t-number:#b5cea8;--t-variable:#9cdcfe;--t-tag:#569cd6;--t-regexp:#d16969;--t-meta:#569cd6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.7 var(--sans);-webkit-font-smoothing:antialiased}
::selection{background:var(--sel)}
a{color:var(--accent);text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

.layout{display:grid;grid-template-columns:266px minmax(0,1fr);align-items:start}
.layout.has-toc{grid-template-columns:266px minmax(0,1fr) 216px}

/* ---- sidebar ---- */
.sidebar{position:sticky;top:0;max-height:100vh;overflow-y:auto;border-right:1px solid var(--line);padding:26px 16px 40px;font-family:var(--mono)}
.site{display:block;padding:0 10px 18px;font-size:13px;font-weight:600;color:var(--fg);letter-spacing:-.01em;overflow-wrap:anywhere}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar a{display:block;padding:5px 10px;border-left:2px solid transparent;color:var(--dim);font-size:13px;line-height:1.45}
.sidebar a:hover{color:var(--fg)}
.sidebar a.active{color:var(--fg);border-left-color:var(--accent);background:var(--card)}
.sidebar .d1 a{padding-left:24px}.sidebar .d2 a{padding-left:38px}
.nav-btn,.nav-state{display:none}

/* ---- content ---- */
.content{padding:52px 60px 80px;min-width:0}
article,.pager,.doc-actions,.raw{max-width:var(--measure);margin-inline:auto}
article>:first-child{margin-top:0}
h1,h2,h3,h4{line-height:1.25;letter-spacing:-.02em;overflow-wrap:break-word}
h1{font-size:32px;margin:0 0 24px}
h2{font-size:23px;margin:52px 0 16px;padding-top:20px;border-top:1px solid var(--line)}
h3{font-size:18px;margin:32px 0 12px}
h4{font-size:16px;margin:26px 0 10px}
.anchor{opacity:0;margin-left:.35em;color:var(--dim);font-weight:400;transition:opacity .12s}
h2:hover .anchor,h3:hover .anchor,.anchor:focus{opacity:1}
p,ul,ol,blockquote,table,pre,details{margin:0 0 18px}
ul,ol{padding-left:22px}li{margin:5px 0}li>ul,li>ol{margin:5px 0}
li::marker{color:var(--dim)}
hr{border:0;border-top:1px solid var(--line);margin:40px 0}
blockquote{border-left:2px solid var(--accent);padding:2px 0 2px 18px;color:var(--dim)}
blockquote>:last-child{margin-bottom:0}
img{max-width:100%;height:auto}
strong{font-weight:600}
kbd{font:500 12px var(--mono);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:1px 5px;background:var(--card)}
abbr{text-decoration-color:var(--dim)}
article a{text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 40%,transparent);text-underline-offset:3px}
article a:hover{text-decoration-color:var(--accent)}

/* GFM task lists — no bullet, checkbox on the text baseline */
li:has(>input[type=checkbox]){list-style:none;margin-left:-22px;padding-left:22px}
li>input[type=checkbox]{margin:0 8px 0 -22px;accent-color:var(--accent);vertical-align:middle}

/* ---- source view: the same pure-CSS checkbox trick as the nav, so the raw
   markdown is one click away and still there with JS off ---- */
.raw-state{position:absolute;width:1px;height:1px;opacity:0;margin:0}
.doc-actions{display:flex;justify-content:flex-end;gap:8px;margin-bottom:14px}
.act{display:inline-flex;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--dim);font:500 11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:7px 10px;cursor:pointer}
.act:hover{color:var(--fg);border-color:var(--accent)}
#raw:focus-visible~.layout .act[for=raw]{outline:2px solid var(--accent);outline-offset:3px}
.act .rendered{display:none}
.raw{display:none;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:18px 20px;font:400 13.5px/1.75 var(--mono)}
#raw:checked~.layout .act .rendered{display:inline}
#raw:checked~.layout .act .source{display:none}
/* the toc column stays reserved while its links are hidden, so toggling the
   source never shifts the text sideways */
#raw:checked~.layout article,#raw:checked~.layout .pager,#raw:checked~.layout .toc{display:none}
#raw:checked~.layout .raw{display:block}

/* ---- code ---- */
code{font-family:var(--mono);font-size:.875em}
:not(pre)>code{background:var(--card);border:1px solid var(--line);padding:.5px 5px;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;line-height:1.6}
pre code{background:0;border:0;padding:0;font-size:13.5px}
pre.mermaid{background:0;border:0;padding:0;text-align:center;line-height:normal}
pre.mermaid svg{max-width:100%;height:auto}
/* the wrapper, not the <pre>, is the positioning context: <pre> scrolls, so
   anything absolute inside it would scroll away with the code */
.codeblock{position:relative;margin:0 0 18px}
.codeblock pre{margin:0}
.copy{position:absolute;top:7px;right:7px;opacity:0;transition:opacity .12s;background:var(--bg);color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:3px 9px;font:500 11px var(--mono);cursor:pointer}
.codeblock:hover .copy,.copy:focus{opacity:1}.copy:hover{color:var(--fg)}
/* the language label hands its corner over to the copy button on hover */
.codeblock[data-lang]::before{content:attr(data-lang);position:absolute;top:10px;right:12px;font:400 11px var(--mono);color:var(--dim);transition:opacity .12s}
.codeblock[data-lang]:hover::before{opacity:0}

/* Syntax: VS Code's own token colors — Dark+ and Light+ — because a code block
   should look like the editor the reader already reads code in. */
.hljs-comment,.hljs-quote{color:var(--t-comment)}
.hljs-keyword,.hljs-literal,.hljs-selector-tag,.hljs-doctag,.hljs-meta .hljs-keyword{color:var(--t-keyword)}
.hljs-built_in,.hljs-type,.hljs-title.class_,.hljs-class .hljs-title{color:var(--t-type)}
.hljs-title,.hljs-title.function_,.hljs-section{color:var(--t-function)}
.hljs-string,.hljs-meta .hljs-string,.hljs-char.escape_{color:var(--t-string)}
.hljs-number,.hljs-symbol,.hljs-bullet{color:var(--t-number)}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-property,.hljs-params,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-link{color:var(--t-variable)}
.hljs-name,.hljs-selector-class,.hljs-selector-id{color:var(--t-tag)}
.hljs-regexp{color:var(--t-regexp)}
.hljs-meta{color:var(--t-meta)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}
.hljs-addition{color:var(--add)}.hljs-deletion{color:var(--del)}

/* ---- tables ---- */
.scroll{overflow-x:auto;margin:0 0 18px}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600}

/* ---- on this page ---- */
.toc{position:sticky;top:0;max-height:100vh;overflow-y:auto;padding:56px 24px 40px 0;font-family:var(--mono);font-size:12px}
.toc h2{all:unset;display:block;color:var(--dim);margin-bottom:10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.toc ul{list-style:none;margin:0;padding:0}
.toc a{display:block;padding:4px 0;color:var(--dim);line-height:1.45}
.toc a:hover{color:var(--fg)}
.toc .h3 a{padding-left:14px}

/* ---- prev / next ---- */
.pager{display:flex;justify-content:space-between;gap:14px;margin-top:56px;border-top:1px solid var(--line);padding-top:22px}
.pager a{flex:0 1 48%;border:1px solid var(--line);border-radius:8px;padding:12px 16px;color:var(--fg);font-size:14px;font-weight:500}
.pager a:hover{border-color:var(--accent)}
.pager .next{margin-left:auto;text-align:right}
.pager span{display:block;color:var(--dim);font:400 11px/2 var(--mono);text-transform:uppercase;letter-spacing:.06em}

/* ---- mobile: the sidebar collapses behind a pure-CSS toggle ---- */
@media(max-width:900px){
.layout,.layout.has-toc{grid-template-columns:minmax(0,1fr)}
.toc{display:none}
.sidebar{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line);padding:14px 16px}
.site{display:inline-block;padding:0;line-height:26px}
/* the checkbox is the open/closed state: invisible, but still tab-reachable */
.nav-state{display:block;position:absolute;width:1px;height:1px;opacity:0;margin:0}
.nav-btn{display:block;float:right;color:var(--dim);cursor:pointer;padding:1px 0 0}
.nav-btn svg{display:block;width:22px;height:22px}
.nav-btn .close{display:none}
#nav:checked~.layout .nav-btn .open{display:none}
#nav:checked~.layout .nav-btn .close{display:block}
#nav:focus-visible~.layout .nav-btn{outline:2px solid var(--accent);outline-offset:4px;border-radius:3px}
.sidebar ul{display:none;padding-top:12px;clear:both}
#nav:checked~.layout .sidebar ul{display:block}
.content{padding:28px 22px 64px}
h1{font-size:27px}h2{font-size:21px}
.raw{padding:14px 14px;font-size:12.5px}
/* a table scrolls in its wrapper instead of squeezing into four unreadable columns */
table{min-width:34em}
.pager a{font-size:13px}
}
@media print{
.sidebar,.toc,.pager,.copy,.anchor,.doc-actions,.raw,#as-share{display:none!important}
.layout,.layout.has-toc{grid-template-columns:1fr}
.content{padding:0}article{display:block!important;max-width:none}
pre,code{background:0}
}
`;

// Hamburger / close, drawn once and swapped by the nav checkbox in CSS.
const MENU_ICONS =
  '<svg class="open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>' +
  '<svg class="close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';

export function markdownShell(opts: {
  siteId: string;
  title: string;
  contentHtml: string;
  source: string;
  sidebarHtml: string;
  tocHtml?: string;
  pagerHtml?: string;
  mermaid?: boolean;
}): string {
  // Mermaid diagrams render client-side from <pre class="mermaid"> blocks. Loaded
  // lazily as an ES module only on pages that actually use a ```mermaid fence,
  // and themed to whatever scheme the reader's OS is in.
  const mermaidScript = opts.mermaid
    ? `<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true,theme:matchMedia("(prefers-color-scheme:dark)").matches?"dark":"neutral"});</script>`
    : "";
  const toc = opts.tocHtml
    ? `<aside class="toc"><h2>On this page</h2>${opts.tocHtml}</aside>`
    : "";
  const pager = opts.pagerHtml ? `<nav class="pager">${opts.pagerHtml}</nav>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(opts.title)} · ${esc(opts.siteId)}</title>
<style>${DOC_CSS}</style></head><body>
<input type="checkbox" id="nav" class="nav-state" aria-label="Menu">
<input type="checkbox" id="raw" class="raw-state" aria-label="Show markdown source">
<div class="layout${toc ? " has-toc" : ""}">
<nav class="sidebar"><label class="nav-btn" for="nav" aria-hidden="true">${MENU_ICONS}</label><a class="site" href="/">${esc(opts.siteId)}</a>${opts.sidebarHtml}</nav>
<main class="content">
<div class="doc-actions"><label class="act" for="raw"><span class="source">Markdown</span><span class="rendered">Rendered</span></label></div>
<article>${opts.contentHtml}</article><pre class="raw" id="raw-src">${esc(opts.source)}</pre>${pager}</main>
${toc}</div>
<script>${DOC_JS}</script>${mermaidScript}</body></html>`;
}

// Progressive enhancement only: a copy button per code block, one for the whole
// markdown source, and wide tables get their own scroll container so they never
// stretch the prose column.
const DOC_JS = `(function(){
var t=document.querySelectorAll("article table");for(var i=0;i<t.length;i++){var w=document.createElement("div");w.className="scroll";t[i].parentNode.insertBefore(w,t[i]);w.appendChild(t[i])}
if(!navigator.clipboard)return;
var flash=function(b,text){return function(){navigator.clipboard.writeText(text()).then(function(){var prev=b.getAttribute("data-label");b.textContent="Copied";setTimeout(function(){b.textContent=prev},1400)})}};
document.querySelectorAll("article .codeblock>pre>code").forEach(function(c){var b=document.createElement("button");b.className="copy";b.type="button";b.textContent="Copy";b.setAttribute("data-label","Copy");
b.addEventListener("click",flash(b,function(){return c.textContent}));c.parentNode.parentNode.appendChild(b)});
var src=document.getElementById("raw-src");
if(src){var cb=document.createElement("button");cb.className="act";cb.type="button";cb.textContent="Copy";cb.setAttribute("data-label","Copy");
cb.addEventListener("click",flash(cb,function(){return src.textContent}));document.querySelector(".doc-actions").appendChild(cb)}})();`;

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function assetDownloadHtml(opts: {
  name: string;
  bytes: number;
  contentType: string;
  downloadUrl: string;
  shareUrl: string;
}): string {
  const share = JSON.stringify(opts.shareUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(opts.name)} · agenthost</title>
<style>
:root{--bg:#f5f7fa;--surface:#fff;--text:#111827;--muted:#667085;--line:#d9dee7;--button:#1d4ed8;--button-text:#fff;--shadow:0 18px 50px rgba(28,39,60,.10)}
:root[data-theme="dark"]{--bg:#0d1117;--surface:#161b22;--text:#f0f3f6;--muted:#9aa7b5;--line:#30363d;--button:#4f8cff;--button-text:#07101f;--shadow:0 18px 50px rgba(0,0,0,.32)}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d1117;--surface:#161b22;--text:#f0f3f6;--muted:#9aa7b5;--line:#30363d;--button:#4f8cff;--button-text:#07101f;--shadow:0 18px 50px rgba(0,0,0,.32)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.card{width:min(100%,520px);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);padding:32px}
.mark{width:48px;height:48px;display:grid;place-items:center;border:1px solid var(--line);margin-bottom:24px;color:var(--button)}
.mark svg{width:23px;height:23px}h1{font-size:22px;line-height:1.25;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere;margin:0 0 8px}.meta{color:var(--muted);font-size:13px;margin-bottom:28px}.actions{display:grid;grid-template-columns:1fr auto;gap:10px}
.button{min-height:46px;display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line);padding:0 18px;color:var(--text);background:transparent;font:600 14px/1 inherit;text-decoration:none;cursor:pointer}.button.primary{background:var(--button);border-color:var(--button);color:var(--button-text)}.button:hover{filter:brightness(.96)}.button:focus-visible{outline:3px solid color-mix(in srgb,var(--button) 35%,transparent);outline-offset:2px}.brand{margin-top:24px;color:var(--muted);font-size:12px}.brand a{color:inherit}
@media(max-width:460px){.card{padding:24px}.actions{grid-template-columns:1fr}.button{width:100%}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style></head><body><main class="card">
<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg></div>
<h1>${esc(opts.name)}</h1><div class="meta">${esc(formatBytes(opts.bytes))} · ${esc(opts.contentType)}</div>
<div class="actions"><a class="button primary" href="${esc(opts.downloadUrl)}">Download</a><button class="button" id="share" type="button">Copy link</button></div>
<div class="brand">Shared with <a href="https://agenthost.page">agenthost</a></div>
</main><script>(function(){var b=document.getElementById('share'),u=${share};b.addEventListener('click',function(){var done=function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy link'},1400)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done).catch(function(){prompt('Copy this link:',u)})}else{prompt('Copy this link:',u)}})})();</script></body></html>`;
}

export function assetPendingHtml(name: string): string {
  return errorHtml(425, esc(name), "The upload has not completed yet.", 28);
}

function errorHtml(code: number, heading: string, message: string, h1Size: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${code} · agenthost</title>
<style>${SHELL_CSS}.wrap{min-height:100vh;display:grid;place-items:center;text-align:center;padding:24px}
h1{font-size:${h1Size}px;margin:0}p{color:var(--muted)}</style></head>
<body><div class="wrap"><div><h1>${heading}</h1><p>${message}</p></div></div></body></html>`;
}

export const notFoundHtml = () => errorHtml(404, "404", "This page could not be found.", 64);
export const goneHtml = () => errorHtml(410, "410 Gone", "This site has been removed.", 48);
