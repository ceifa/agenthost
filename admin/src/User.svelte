<script>
  import Confirm from "./Confirm.svelte";
  import { APEX, api, post, flash, siteHost, fmtBytes, fmtDate, ago } from "./lib.svelte.js";

  // Keyed by username in App, so one instance only ever shows one account.
  let { user, focusSite = null, onchange } = $props();

  let sites = $state([]);
  let siteCursor = $state(null);
  let loading = $state(true);
  let paging = $state(false);
  let renaming = $state(false);
  let newName = $state("");
  let busy = $state(false);
  let domainFor = $state(null);
  let domainHost = $state("");
  let domainSetup = $state(null);

  const stored = $derived(sites.reduce((n, x) => n + x.bytes, 0));
  const query = () => "?username=" + encodeURIComponent(user.username);

  async function load() {
    try {
      const s = await api("/sites" + query());
      sites = s.sites;
      siteCursor = s.cursor;
    } catch (e) {
      flash(e.message, true);
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    paging = true;
    try {
      const d = await api(`/sites${query()}&cursor=${encodeURIComponent(siteCursor)}`);
      sites.push(...d.sites);
      siteCursor = d.cursor;
    } catch (e) {
      flash(e.message, true);
    } finally {
      paging = false;
    }
  }

  async function setPlan(plan) {
    if (plan === user.plan) return;
    try {
      await post("/plan", { username: user.username, plan });
      onchange({ plan });
      flash(`${user.username} is now on ${plan}`);
    } catch (e) {
      flash(e.message, true);
    }
  }

  async function rename(e) {
    e.preventDefault();
    const to = newName.trim();
    if (to === user.username) return (renaming = false);
    busy = true;
    try {
      await post("/rename", { from: user.username, to });
      flash(`Renamed ${user.username} to ${to}`);
      onchange({ username: to });
    } catch (e) {
      flash(e.message, true);
      busy = false;
    }
  }

  async function takedown(s, tombstone) {
    try {
      await post("/takedown", { username: user.username, siteId: s.siteId, tombstone });
      s.tombstone = tombstone;
      flash(tombstone ? `${s.siteId} taken down` : `${s.siteId} restored`);
    } catch (e) {
      flash(e.message, true);
    }
  }

  function openDomain(s) {
    domainFor = s.siteId;
    domainHost = "";
    domainSetup = null;
  }

  async function mapDomain(e) {
    e.preventDefault();
    busy = true;
    try {
      const d = await post("/domain", { host: domainHost, username: user.username, siteId: domainFor });
      onchange({ customDomain: d.host });
      domainSetup = { host: d.host, steps: d.provision?.steps ?? [] };
      flash(`Added ${d.host}`);
    } catch (e) {
      flash(e.message, true);
    } finally {
      busy = false;
    }
  }

  const escape = (close) => (e) => e.key === "Escape" && close();

  load();
</script>

<article>
  <header class="head">
    <div class="who">
      {#if renaming}
        <form class="inline" onsubmit={rename}>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={newName} aria-label="New username" pattern={"[a-z0-9]{2,30}"} required autofocus
            onkeydown={escape(() => (renaming = false))} />
          <button class="primary" disabled={busy}>{busy ? "Renaming…" : "Rename"}</button>
          <button type="button" disabled={busy} onclick={() => (renaming = false)}>Cancel</button>
          <p class="hint">2–30 lowercase letters and digits. Every share moves to a new address, links to the old addresses stop working, and the owner token's prefix becomes the new name.</p>
        </form>
      {:else}
        <h1>{user.username}</h1>
        <button onclick={() => { newName = user.username; renaming = true; }}>Rename</button>
      {/if}
    </div>
    <div class="plan" role="group" aria-label="Plan">
      {#each ["free", "paid"] as plan}
        <button class:on={user.plan === plan} aria-pressed={user.plan === plan} onclick={() => setPlan(plan)}>{plan}</button>
      {/each}
    </div>
  </header>

  <dl class="facts">
    <div><dt>Joined</dt><dd title={fmtDate(user.createdAt)}>{ago(user.createdAt)}</dd></div>
    <div><dt>Email</dt><dd>{#if user.email}<a href="mailto:{user.email}">{user.email}</a>{:else}<span class="dim">none</span>{/if}</dd></div>
    <div><dt>Custom domain</dt><dd>{#if user.customDomain}<a href="https://{user.customDomain}" target="_blank" rel="noreferrer">{user.customDomain}</a>{:else}<span class="dim">none</span>{/if}</dd></div>
    <div><dt>Storage</dt><dd>{loading ? "…" : fmtBytes(stored)}{siteCursor ? "+" : ""}</dd></div>
  </dl>

  <section>
    <h2>Shares <span class="n">{sites.length}{siteCursor ? "+" : ""}</span></h2>
    {#if loading}
      <p class="empty">Loading…</p>
    {:else if sites.length === 0}
      <p class="empty">No shares published.</p>
    {:else}
      <div class="table sites">
        <div class="tr th"><span>Address</span><span>Visibility</span><span class="num">Size</span><span class="num">Files</span><span>Deployed</span><span></span></div>
        {#each sites as s (s.siteId)}
          <div class="tr" class:down={s.tombstone} class:focus={focusSite === s.siteId}>
            <span class="addr">
              <a href="https://{siteHost(user.username, s.siteId)}/" target="_blank" rel="noreferrer"><span class="dim">{user.username}-</span>{s.siteId}<span class="dim">.{APEX}</span></a>
              {#if s.tombstone}<span class="tag red">taken down</span>{/if}
            </span>
            <span class:dim={!s.public}>{s.public ? "Public" : "Private"}</span>
            <span class="num">{fmtBytes(s.bytes)}</span>
            <span class="num">{s.fileCount}</span>
            <span title={fmtDate(s.lastDeployAt)}>{ago(s.lastDeployAt)}</span>
            <span class="acts">
              <button onclick={() => openDomain(s)}>Add domain</button>
              {#if s.tombstone}
                <button onclick={() => takedown(s, false)}>Restore</button>
              {:else}
                <Confirm label="Take down" confirm="Confirm take down" onconfirm={() => takedown(s, true)} />
              {/if}
            </span>
          </div>
          {#if domainFor === s.siteId}
            <div class="drawer">
              {#if domainSetup}
                <p><b>{domainSetup.host}</b> now serves {s.siteId}. Finish the one-time setup in the Cloudflare dashboard:</p>
                <ol>{#each domainSetup.steps as step}<li>{step}</li>{/each}</ol>
                <button onclick={() => (domainFor = null)}>Done</button>
              {:else}
                <form class="inline" onsubmit={mapDomain}>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input bind:value={domainHost} placeholder="status.example.com" aria-label="Custom domain" required autofocus
                    onkeydown={escape(() => (domainFor = null))} />
                  <button class="primary" disabled={busy}>{busy ? "Adding…" : "Add domain"}</button>
                  <button type="button" onclick={() => (domainFor = null)}>Cancel</button>
                  <p class="hint">
                    {#if user.customDomain}Replaces {user.customDomain}, the account's current domain.{:else}One custom domain per account.{/if}
                  </p>
                </form>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
      {#if siteCursor}<button class="more" disabled={paging} onclick={loadMore}>Load more shares</button>{/if}
    {/if}
  </section>

</article>

<style>
  article { padding: 28px 36px 64px; }

  .head { display: flex; align-items: flex-start; gap: 14px; }
  .who { flex: 1; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; min-width: 0; }
  h1 { font: 500 26px/1.2 var(--mono); letter-spacing: -0.02em; margin: 0; overflow-wrap: anywhere; }
  .plan { margin-left: auto; display: flex; border: 1px solid var(--line); }
  .plan button { border: 0; text-transform: capitalize; min-width: 64px; }
  .plan button.on { background: var(--fg); color: var(--bg); cursor: default; }

  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0; margin: 22px 0 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .facts div { padding: 12px 0; }
  dt { color: var(--dim); font-size: 12px; }
  dd { margin: 2px 0 0; font-size: 14px; overflow-wrap: anywhere; }
  dd a { border-bottom: 1px solid var(--line); }
  dd a:hover { border-color: var(--fg); }

  section { margin-top: 36px; }
  h2 { font-size: 15px; font-weight: 600; margin: 0 0 10px; }
  .n { color: var(--dim); font-weight: 400; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .empty { color: var(--dim); font-size: 14px; padding: 14px 0; border-top: 1px solid var(--line); }

  /* Rows are subgrids so every column lines up with its header. */
  .table { display: grid; column-gap: 16px; border-top: 1px solid var(--line); font-size: 14px; }
  .sites { grid-template-columns: minmax(0, 1fr) auto auto auto auto auto; }
  .tr { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; padding: 9px 10px; border-bottom: 1px solid var(--line); border-left: 2px solid transparent; }
  .th { color: var(--dim); font-size: 12px; padding-top: 7px; padding-bottom: 7px; }
  .tr:not(.th):hover { background: var(--panel); }
  .tr.focus { border-left-color: var(--accent); background: var(--panel); }
  .tr.down .addr a { text-decoration: line-through; text-decoration-color: var(--dim); color: var(--dim); }
  .tr > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .addr { font-family: var(--mono); font-size: 13.5px; }
  .addr a:hover { text-decoration: underline; text-underline-offset: 3px; }
  .acts { display: flex; gap: 6px; justify-content: flex-end; }
  .acts button { padding: 4px 10px; font-size: 13px; }

  .tag { font: 500 11px var(--sans); color: var(--dim); border: 1px solid var(--line); padding: 1px 6px; margin-left: 8px; vertical-align: 1px; }
  .tag.red { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }

  .drawer { grid-column: 1 / -1; padding: 14px 10px 16px 22px; border-bottom: 1px solid var(--line); border-left: 2px solid var(--accent); background: var(--panel); font-size: 14px; }
  .drawer p { margin: 0 0 8px; }
  .drawer ol { margin: 0 0 12px; padding-left: 20px; color: var(--dim); }
  .drawer li { margin: 4px 0; }

  .inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .inline input { width: 260px; }
  .hint { flex-basis: 100%; margin: 0; color: var(--dim); font-size: 12.5px; }
  .more { margin-top: 12px; }

  @media (max-width: 760px) {
    article { padding: 20px 16px 48px; }
    .head { flex-wrap: wrap; }
    h1 { font-size: 22px; }
    .sites { grid-template-columns: auto 1fr auto; }
    .tr { row-gap: 4px; }
    .th { display: none !important; }
    .tr > .addr { grid-column: 1 / -1; white-space: normal; overflow-wrap: anywhere; }
    .sites .tr > span:nth-child(4), .sites .tr > span:nth-child(5) { display: none; }
  }
</style>
