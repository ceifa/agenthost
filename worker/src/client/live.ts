// Live reload for every HTML page the Worker serves.
//
// The Worker inlines this script (minified by scripts/build-client.mjs) next to
// the Share widget. The <script> tag carries the page's version tag in
// data-version and the tuning constants (LIVE in ../config.ts) as JSON in
// data-cfg, so the constants have one source of truth.
//
// Strategy: poll /_gen and do a plain location.reload() when the version
// changes. The browser restores scroll natively and the page's own JS starts
// clean, so this works the same on our markdown shell and on user HTML.
// Every poll is a Worker invocation, so we poll rarely: only while visible,
// slower when the reader is idle, with backoff on errors (an error never
// reloads). A pending reload waits until no text is selected and no input is
// focused. Pages opt out with <meta name="agenthost-live" content="off">.

interface LiveConfig {
  fastMs: number; // cadence for a recently published site
  fastForMs: number; // how long the fast cadence lasts
  baseMs: number; // steady-state cadence
  idleMs: number; // cadence once the reader has been idle for idleAfterMs
  idleAfterMs: number;
  maxBackoffMs: number; // cap for exponential backoff on errors
  busyRetryMs: number; // re-check interval while a reload waits for the reader
}

// A module, so `main` stays local to this file instead of a global shared by the
// other client scripts when they are typechecked together.
export {};

function main() {
  if (document.querySelector('meta[name="agenthost-live"][content="off"]')) return;

  const script = document.currentScript as HTMLScriptElement | null;
  const version = script?.dataset.version;
  const rawCfg = script?.dataset.cfg;
  if (!version || !rawCfg) return;
  const cfg: LiveConfig = JSON.parse(rawCfg);

  const loadedAt = Date.now();
  const recentUntil = Number(script?.dataset.deployedAt ?? 0) + cfg.fastForMs;
  let lastActivity = loadedAt;
  let lastCheck = 0;
  let failures = 0;
  let reloadPending = false;
  let inFlight = false;
  let timer = 0;
  let etag: string | null = null;
  let observedVersion = version;
  // The browser releases Web Locks if the tab closes or crashes. Hidden tabs
  // release voluntarily so a visible reader can take over. Older browsers use
  // the existing independent polling behavior.
  let coordinated = typeof BroadcastChannel !== "undefined" && !!navigator.locks;
  let channel: BroadcastChannel | null = null;
  let leader = !coordinated;
  let claiming = false;
  let releaseLeader: (() => void) | null = null;
  if (coordinated) {
    try { channel = new BroadcastChannel("agenthost-live-v2"); }
    catch { coordinated = false; leader = true; }
  }

  function observe(next: string) {
    if (!/^g\d+-r\d+$/.test(next)) return;
    observedVersion = next;
    // A just-published page can hear an older generation until the probe's
    // micro-cache expires; that is not a reason to reload back to old content.
    const currentGen = Number(version!.split("-")[0]!.slice(1));
    const nextGen = Number(next.split("-")[0]!.slice(1));
    if (next !== version && nextGen >= currentGen) reload();
  }
  if (channel) channel.onmessage = (event: MessageEvent) => {
    if (typeof event.data?.version !== "string" || event.data.version.length > 80) return;
    lastCheck = Date.now();
    if (document.visibilityState === "visible") observe(event.data.version);
  };

  function claimLeadership() {
    if (claiming || leader || document.visibilityState === "hidden") return;
    claiming = true;
    void Promise.resolve().then(() => navigator.locks.request("agenthost-live-v2", { ifAvailable: true }, async (lock) => {
      if (!lock || document.visibilityState === "hidden") return;
      leader = true;
      const released = new Promise<void>(resolve => { releaseLeader = resolve; });
      if (Date.now() - lastCheck >= cfg.busyRetryMs) tick();
      else schedule(nextDelay());
      await released;
      leader = false;
      releaseLeader = null;
    })).catch(() => {
      // Disabled locking should not disable updates.
      coordinated = false;
      leader = true;
    }).finally(() => {
      claiming = false;
      if (document.visibilityState === "visible" && !reloadPending) schedule(leader ? nextDelay() : cfg.busyRetryMs);
    });
  }

  const markActive = () => {
    lastActivity = Date.now();
  };
  for (const event of ["scroll", "keydown", "pointerdown", "pointermove", "touchstart"]) {
    addEventListener(event, markActive, { passive: true });
  }

  // How long to wait before the next poll, with ±10% jitter so many readers of
  // the same page don't line up.
  function nextDelay(): number {
    const now = Date.now();
    let ms: number;
    if (now < recentUntil) ms = cfg.fastMs;
    else if (now - lastActivity > cfg.idleAfterMs) ms = cfg.idleMs;
    else ms = cfg.baseMs;
    if (failures) ms = Math.min(cfg.maxBackoffMs, ms * 2 ** failures);
    return ms + Math.random() * ms * 0.2;
  }

  // Reloading would destroy a text selection or something being typed.
  function readerIsBusy(): boolean {
    const selection = window.getSelection?.();
    if (selection && String(selection)) return true;
    const active = document.activeElement as HTMLElement | null;
    return !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
  }

  function schedule(ms: number) {
    clearTimeout(timer);
    timer = window.setTimeout(tick, ms);
  }

  function reload() {
    if (readerIsBusy()) {
      reloadPending = true;
      schedule(cfg.busyRetryMs);
    } else {
      location.reload();
    }
  }

  function tick() {
    if (document.visibilityState === "hidden") {
      timer = 0;
      return;
    }
    if (reloadPending) return reload();
    if (coordinated && !leader) {
      claimLeadership();
      if (!leader) schedule(cfg.busyRetryMs);
      return;
    }
    if (inFlight) return;

    inFlight = true;
    lastCheck = Date.now();
    const headers: Record<string, string> = {};
    if (etag) headers["if-none-match"] = etag;

    fetch("/_gen", { cache: "no-store", credentials: "omit", headers })
      .then((res) => {
        if (res.status === 304) {
          failures = 0;
          channel?.postMessage({ version: observedVersion });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        failures = 0;
        etag = res.headers.get("etag");
        return res.text().then((body) => {
          const next = body.trim();
          channel?.postMessage({ version: next });
          observe(next);
        });
      })
      .catch(() => {
        failures++;
      })
      .then(() => {
        inFlight = false;
        if (!reloadPending && document.visibilityState !== "hidden") schedule(nextDelay());
      });
  }

  // Coming back to the tab is exactly when the reader wants the latest version:
  // check right away, unless we just did.
  function wake() {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheck < cfg.busyRetryMs) return;
    tick();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      wake();
    } else {
      clearTimeout(timer);
      timer = 0;
      releaseLeader?.();
    }
  });
  addEventListener("focus", wake);
  addEventListener("pagehide", () => { releaseLeader?.(); channel?.close(); });
  addEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) location.reload();
  });

  schedule(nextDelay());
}

main();
