<script>
  import User from "./User.svelte";
  import { api, notice, flash, parseHost, ago } from "./lib.svelte.js";

  let users = $state([]);
  let cursor = $state(null);
  let loading = $state(true);
  let search = $state("");
  let sites = $state("all");
  let searchBox;
  // The selection lives in the URL hash so a reload keeps the account open.
  let selected = $state(decodeURIComponent(location.hash.slice(1)));

  const target = $derived(parseHost(search.trim().toLowerCase()));
  const filtered = $derived(sites === "all" ? users : users.filter((u) => u.hasSites === (sites === "with")));
  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return filtered;
    if (target?.username) return filtered.filter((u) => u.username === target.username);
    if (target?.host) return filtered.filter((u) => u.customDomain === target.host);
    return filtered.filter((u) => [u.username, u.email, u.customDomain].some((v) => v?.toLowerCase().includes(q)));
  });
  const narrowed = $derived(!!search || sites !== "all");
  const user = $derived(users.find((u) => u.username === selected));

  async function loadUsers(more = false) {
    loading = true;
    try {
      const d = await api("/users" + (more && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
      users = [...(more ? users : []), ...d.users].sort((a, b) => b.createdAt - a.createdAt);
      cursor = d.cursor;
    } catch (e) {
      flash(e.message, true);
    } finally {
      loading = false;
    }
  }

  async function loadAll() {
    while (cursor) await loadUsers(true);
  }

  function select(username) {
    selected = username;
    history.replaceState(null, "", "#" + encodeURIComponent(username));
  }

  function change(patch) {
    Object.assign(user, patch);
    if (patch.username) {
      search = "";
      select(patch.username);
    }
  }

  function onSearchKey(e) {
    if (e.key === "Enter" && shown.length) select(shown[0].username);
    if (e.key === "Escape") search = "";
  }

  function onKey(e) {
    if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      searchBox.focus();
    }
  }

  loadUsers();
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <aside>
    <div class="brand">agenthost <span>admin</span></div>
    <div class="search">
      <input bind:this={searchBox} bind:value={search} onkeydown={onSearchKey} type="search"
        placeholder="Username, email or site URL" aria-label="Find an account" />
      <kbd>/</kbd>
    </div>
    <div class="filter" role="group" aria-label="Filter by sites">
      {#each [["all", "All"], ["with", "With sites"], ["without", "No sites"]] as [value, label]}
        <button class:on={sites === value} aria-pressed={sites === value} onclick={() => (sites = value)}>{label}</button>
      {/each}
    </div>
    <div class="count">
      {#if loading && !users.length}
        Loading accounts…
      {:else if narrowed}
        {shown.length} of {users.length}{cursor ? "+" : ""} accounts
      {:else}
        {users.length}{cursor ? "+" : ""} accounts
      {/if}
      <button class="link" disabled={loading} onclick={() => loadUsers()}>Refresh</button>
    </div>
    <ul>
      {#each shown as u (u.username)}
        <li>
          <button class="row" class:on={u.username === selected} onclick={() => select(u.username)}>
            <span class="name">{u.username}</span>
            {#if u.plan === "paid"}<span class="paid">paid</span>{/if}
            <span class="sub">{u.customDomain ?? u.email ?? `joined ${ago(u.createdAt)}`}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if !loading && narrowed && !shown.length}
      <p class="none">No loaded account matches.</p>
    {/if}
    {#if cursor}
      <button class="more" disabled={loading} onclick={() => (narrowed ? loadAll() : loadUsers(true))}>
        {narrowed ? "Search all accounts" : "Load more accounts"}
      </button>
    {/if}
  </aside>

  <main>
    {#if user}
      {#key user.username}
        <User {user} focusSite={target?.username === user.username ? target.siteId : null} onchange={change} />
      {/key}
    {:else}
      <div class="blank">
        <p>Pick an account on the left, or paste a site URL from an abuse report to find its owner.</p>
      </div>
    {/if}
  </main>
</div>

{#if notice.text}
  <div class="notice" class:error={notice.error} role="status">
    {notice.text}
    {#if notice.error}<button class="link" onclick={() => (notice.text = "")}>Dismiss</button>{/if}
  </div>
{/if}

<style>
  .shell { display: grid; grid-template-columns: 300px 1fr; min-height: 100vh; }
  aside { border-right: 1px solid var(--line); padding: 20px 0 24px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { font: 500 15px var(--mono); padding: 0 20px 18px; }
  .brand span { color: var(--accent); }

  .search { position: relative; margin: 0 20px; }
  .search input { width: 100%; padding-right: 30px; }
  kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font: 12px var(--mono); color: var(--dim); border: 1px solid var(--line); padding: 0 5px; pointer-events: none; }
  .search input:focus + kbd { display: none; }

  .filter { display: flex; margin: 10px 20px 0; border: 1px solid var(--line); }
  .filter button { flex: 1; border: 0; padding: 5px 0; font-size: 12.5px; color: var(--dim); }
  .filter button:hover { color: var(--fg); }
  .filter button.on { background: var(--fg); color: var(--bg); cursor: default; }

  .count { display: flex; justify-content: space-between; color: var(--dim); font-size: 12.5px; padding: 14px 20px 8px; font-variant-numeric: tabular-nums; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  li { border-bottom: 1px solid var(--line); }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; width: 100%; text-align: left; border: 0; border-left: 3px solid transparent; padding: 10px 20px 10px 17px; background: none; }
  .row:hover { background: var(--panel); }
  .row.on { background: var(--panel); border-left-color: var(--accent); }
  .name { font: 500 14px var(--mono); overflow: hidden; text-overflow: ellipsis; }
  .paid { font-size: 11px; font-weight: 600; color: var(--bg); background: var(--accent); padding: 0 6px; align-self: center; }
  .sub { grid-column: 1 / -1; color: var(--dim); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { color: var(--dim); font-size: 13px; padding: 12px 20px; margin: 0; }
  .more { margin: 14px 20px 0; }

  main { min-width: 0; }
  .blank { display: grid; place-items: center; min-height: 60vh; padding: 32px; }
  .blank p { color: var(--dim); max-width: 26em; text-align: center; margin: 0; }

  .notice { position: fixed; bottom: 20px; right: 20px; display: flex; gap: 14px; align-items: center; background: var(--fg); color: var(--bg); padding: 10px 16px; font-size: 14px; font-weight: 500; max-width: min(520px, calc(100vw - 40px)); }
  .notice.error { background: var(--red); color: #1c0806; }
  .notice .link { color: inherit; text-decoration: underline; }

  @media (max-width: 760px) {
    .shell { grid-template-columns: 1fr; }
    aside { position: static; height: auto; max-height: 45vh; border-right: 0; border-bottom: 1px solid var(--line); }
  }
</style>
