export const APEX = __APEX_HOST__;

export async function api(path, opts) {
  const res = await fetch("/admin/api" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const notice = $state({ text: "", error: false });
let noticeTimer;
export function flash(text, error = false) {
  Object.assign(notice, { text, error });
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.text = ""), error ? 8000 : 2500);
}

export const siteHost = (username, siteId) => `${username}-${siteId}.${APEX}`;

// A pasted site URL or bare host, split back into its owner: usernames are
// hyphen-free, so the subdomain label splits on its first hyphen.
export function parseHost(input) {
  if (!/[./]/.test(input)) return null;
  let host;
  try { host = new URL(input.includes("://") ? input : "https://" + input).hostname; }
  catch { return null; }
  if (!host.endsWith("." + APEX)) return { host };
  const label = host.slice(0, -APEX.length - 1);
  if (label.includes(".")) return null;
  const i = label.indexOf("-");
  return i < 0 ? { username: label } : { username: label.slice(0, i), siteId: label.slice(i + 1) };
}

export const fmtBytes = (b) =>
  b < 1024 ? b + " B"
  : b < 1048576 ? (b / 1024).toFixed(1) + " KB"
  : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB"
  : (b / 1073741824).toFixed(2) + " GB";

export const fmtDate = (t) =>
  new Date(t).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
export function ago(t) {
  const s = (t - Date.now()) / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}
