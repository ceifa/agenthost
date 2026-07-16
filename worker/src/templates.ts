// Branded HTML the Worker generates: interstitial, share widget, markdown shell, 404.

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SHELL_CSS = `
:root{--bg:#0b0d10;--fg:#e7ebef;--muted:#9aa4af;--accent:#5b8cff;--card:#15181d;--border:#252a31}
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
input{flex:1;background:#0b0d10;border:1px solid var(--border);color:var(--fg);border-radius:9px;padding:11px 12px;font-size:15px}
input:focus{outline:2px solid var(--accent);border-color:transparent}
button{background:var(--accent);color:#fff;border:0;border-radius:9px;padding:0 16px;font-size:15px;font-weight:600;cursor:pointer}
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
<button id="as-share-btn" style="display:flex;align-items:center;gap:6px;background:#5b8cff;color:#fff;border:0;border-radius:999px;padding:10px 16px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
<span id="as-share-label">Share</span></button></div>
<script>(function(){var u=${safe};var b=document.getElementById('as-share-btn'),l=document.getElementById('as-share-label');b.addEventListener('click',function(){var done=function(){l.textContent='Copied!';setTimeout(function(){l.textContent='Share'},1500)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done).catch(function(){prompt('Copy this link:',u)})}else{prompt('Copy this link:',u)}})})();</script>`;
}

export function markdownShell(opts: {
  siteId: string;
  title: string;
  contentHtml: string;
  sidebarHtml: string;
  mermaid?: boolean;
}): string {
  // Mermaid diagrams render client-side from <pre class="mermaid"> blocks. Loaded
  // lazily as an ES module only on pages that actually use a ```mermaid fence.
  const mermaidScript = opts.mermaid
    ? `<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true,theme:"dark"});</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base href="/">
<title>${esc(opts.title)}</title>
<style>${SHELL_CSS}
.layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
.sidebar{background:var(--card);border-right:1px solid var(--border);padding:24px 18px;overflow-y:auto}
.sidebar h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 12px}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar li{margin:2px 0}
.sidebar a{display:block;padding:6px 10px;border-radius:7px;color:var(--fg);font-size:14px}
.sidebar a:hover{background:rgba(255,255,255,.04);text-decoration:none}
.sidebar a.active{background:var(--accent);color:#fff}
.content{padding:48px 56px;max-width:820px;overflow-x:auto}
.content h1,.content h2,.content h3{line-height:1.25}
.content h1{font-size:30px;margin-top:0}
.content pre{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto}
.content pre.mermaid{background:transparent;border:0;padding:0;text-align:center;line-height:normal}
.content code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px}
.content :not(pre)>code{background:var(--card);border:1px solid var(--border);padding:1px 5px;border-radius:5px}
.content table{border-collapse:collapse;width:100%}.content th,.content td{border:1px solid var(--border);padding:7px 11px}
.content img{max-width:100%}.content blockquote{border-left:3px solid var(--accent);margin:0;padding:4px 16px;color:var(--muted)}
@media(max-width:720px){.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--border)}.content{padding:28px 22px}}
</style></head><body><div class="layout">
<nav class="sidebar"><h2>${esc(opts.siteId)}</h2>${opts.sidebarHtml}</nav>
<main class="content">${opts.contentHtml}</main>
</div>${mermaidScript}</body></html>`;
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
