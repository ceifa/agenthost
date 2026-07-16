<script>
  const API = "/admin/api";

  let users = $state([]);
  let selected = $state(null);
  let sites = $state([]);
  let loading = $state(true);
  let error = $state("");
  let toast = $state("");

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function flash(msg) {
    toast = msg;
    setTimeout(() => (toast = ""), 2500);
  }

  async function loadUsers() {
    loading = true;
    error = "";
    try {
      const d = await api("/users");
      users = d.users.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function selectUser(u) {
    selected = u;
    sites = [];
    try {
      const d = await api(`/sites?username=${encodeURIComponent(u.username)}`);
      sites = d.sites;
    } catch (e) {
      error = e.message;
    }
  }

  async function setPlan(u, plan) {
    try {
      await api("/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u.username, plan }) });
      u.plan = plan;
      flash(`${u.username} → ${plan}`);
      users = users;
    } catch (e) {
      error = e.message;
    }
  }

  async function rename(u) {
    const to = prompt(`Rename ${u.username} to:`);
    if (!to) return;
    try {
      await api("/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: u.username, to }) });
      flash(`renamed to ${to}`);
      await loadUsers();
      selected = null;
    } catch (e) {
      error = e.message;
    }
  }

  async function takedown(s, tombstone) {
    try {
      await api("/takedown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: selected.username, siteId: s.siteId, tombstone }) });
      s.tombstone = tombstone;
      sites = sites;
      flash(tombstone ? `${s.siteId} taken down` : `${s.siteId} restored`);
    } catch (e) {
      error = e.message;
    }
  }

  async function attachDomain(s) {
    const host = prompt(`Custom domain for ${selected.username}/${s.siteId}:`);
    if (!host) return;
    try {
      const d = await api("/domain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, username: selected.username, siteId: s.siteId }) });
      // Serving works as soon as the mapping is written; routing + TLS are a
      // one-time dashboard step per domain (see the returned checklist).
      const steps = d.provision?.steps ?? [];
      if (steps.length) alert(`Mapped ${host}. Finish setup in the Cloudflare dashboard:\n\n${steps.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}`);
      flash(`mapped ${host} — finish DNS/TLS in dashboard`);
    } catch (e) {
      error = e.message;
    }
  }

  const fmtBytes = (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB");
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  loadUsers();
</script>

<header>
  <h1>⚙️ agenthost admin</h1>
  <button class="ghost" onclick={loadUsers}>↻ Refresh</button>
</header>

{#if error}<div class="error">⚠ {error}</div>{/if}
{#if toast}<div class="toast">{toast}</div>{/if}

<div class="layout">
  <section class="panel">
    <h2>Users <span class="count">{users.length}</span></h2>
    {#if loading}
      <p class="muted">Loading…</p>
    {:else if users.length === 0}
      <p class="muted">No users yet.</p>
    {:else}
      <ul class="list">
        {#each users as u (u.username)}
          <li class:active={selected?.username === u.username}>
            <button class="row" onclick={() => selectUser(u)}>
              <span class="name">{u.username}</span>
              <span class="badge {u.plan}">{u.plan}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="panel">
    {#if !selected}
      <p class="muted">Select a user to manage their sites.</p>
    {:else}
      <h2>{selected.username}</h2>
      <div class="meta">
        <span>plan: <b>{selected.plan}</b></span>
        {#if selected.email}<span>email: {selected.email}</span>{/if}
        <span>since {fmtDate(selected.createdAt)}</span>
      </div>
      <div class="actions">
        {#if selected.plan === "free"}
          <button onclick={() => setPlan(selected, "paid")}>⬆ Upgrade to paid</button>
        {:else}
          <button class="ghost" onclick={() => setPlan(selected, "free")}>⬇ Downgrade to free</button>
        {/if}
        <button class="ghost" onclick={() => rename(selected)}>✎ Rename</button>
      </div>

      <h3>Sites <span class="count">{sites.length}</span></h3>
      {#if sites.length === 0}
        <p class="muted">No sites.</p>
      {:else}
        <table>
          <thead><tr><th>site</th><th>size</th><th>files</th><th>last deploy</th><th></th><th></th></tr></thead>
          <tbody>
            {#each sites as s (s.siteId)}
              <tr class:down={s.tombstone}>
                <td><b>{s.siteId}</b> {#if s.public}<span class="pub">public</span>{/if}{#if s.tombstone}<span class="tomb">down</span>{/if}</td>
                <td>{fmtBytes(s.bytes)}</td>
                <td>{s.fileCount}</td>
                <td>{fmtDate(s.lastDeployAt)}</td>
                <td>
                  {#if s.tombstone}
                    <button class="ghost sm" onclick={() => takedown(s, false)}>restore</button>
                  {:else}
                    <button class="danger sm" onclick={() => takedown(s, true)}>takedown</button>
                  {/if}
                </td>
                <td><button class="ghost sm" onclick={() => attachDomain(s)}>+ domain</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  </section>
</div>

<style>
  :global(:root) { --bg: #0a0c10; --fg: #e8edf2; --muted: #8c97a3; --accent: #6ea0ff; --card: #14181f; --border: #232a33; --green: #7df0c8; --red: #ff6b6b; }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 18px 28px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 19px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  h3 { font-size: 14px; margin: 24px 0 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .count { background: var(--border); color: var(--fg); border-radius: 20px; padding: 1px 8px; font-size: 12px; margin-left: 6px; }
  .layout { display: grid; grid-template-columns: 320px 1fr; gap: 22px; padding: 24px 28px; align-items: start; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { margin: 2px 0; border-radius: 8px; }
  .list li.active { background: rgba(110, 160, 255, .12); }
  .row { display: flex; justify-content: space-between; align-items: center; width: 100%; background: none; border: 0; color: var(--fg); padding: 9px 11px; cursor: pointer; border-radius: 8px; font-size: 14px; }
  .row:hover { background: rgba(255, 255, 255, .04); }
  .name { font-family: ui-monospace, Menlo, monospace; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 20px; text-transform: uppercase; letter-spacing: .03em; }
  .badge.free { background: #232a33; color: var(--muted); }
  .badge.paid { background: var(--green); color: #06231a; }
  .meta { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 13.5px; margin-bottom: 14px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: var(--accent); color: #07111f; border: 0; border-radius: 8px; padding: 8px 13px; font-weight: 600; font-size: 13px; cursor: pointer; }
  button:hover { opacity: .9; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button.danger { background: var(--red); color: #2a0707; }
  button.sm { padding: 5px 9px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 9px 8px; border-bottom: 1px solid var(--border); font-size: 13.5px; }
  tr.down td b { text-decoration: line-through; opacity: .6; }
  .pub { font-size: 11px; color: var(--green); margin-left: 6px; }
  .tomb { font-size: 11px; color: var(--red); margin-left: 6px; }
  .muted { color: var(--muted); }
  .error { background: rgba(255, 107, 107, .12); color: var(--red); padding: 10px 28px; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--green); color: #06231a; padding: 11px 18px; border-radius: 10px; font-weight: 600; box-shadow: 0 6px 20px rgba(0, 0, 0, .3); }
  @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
</style>
