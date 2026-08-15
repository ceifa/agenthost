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
