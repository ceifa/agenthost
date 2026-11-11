// Working on a request's content while its share record is still being read.
//
// The record is read fresh on every request and nothing is sent before it says
// the reader may have it: that part does not change. What changes is that the
// route and the content no longer queue behind that read. Two things make the
// head start possible, and neither decides anything:
//
// - a Gen, a generation that may still be a guess. Lookups in the gen-keyed
//   caches use the guess; writes to them wait for the record to confirm it.
// - a Hint, what this edge location last saw of the share, which is where the
//   guess comes from. A wrong or missing hint costs only the head start.

import type { SiteMeta } from "./storage";

export interface Gen {
  // The generation to look cache entries up under; null when none is known,
  // and then they are skipped.
  guess: number | null;
  // The record's generation once it has authorized this request, else null.
  // Cache writes hang off this, so nothing is stored under a guess.
  confirmed: Promise<number | null>;
  // Set once an answer has come from an entry keyed by the guess: that answer
  // is only good if the guess was right. One read from R2 is good regardless,
  // since file keys don't carry the generation.
  cached: boolean;
}

// A generation already read from the record.
export const knownGen = (gen: number): Gen => ({ guess: gen, confirmed: Promise.resolve(gen), cached: false });

export interface Hint {
  gen: number;
  // Readable without a key, so worth starting on for a request that has none.
  open: boolean;
}

export const hintOf = (meta: SiteMeta): Hint => ({
  gen: meta.generation,
  open: meta.public || !(meta.accessKey || meta.keyHash),
});

const hintRequest = (username: string, siteId: string) => new Request(`https://as-hints.internal/${username}/${siteId}`);

export async function readHint(username: string, siteId: string): Promise<Hint | null> {
  try {
    const hit = await caches.default.match(hintRequest(username, siteId));
    return hit ? await hit.json<Hint>() : null;
  } catch {
    return null;
  }
}

// Best effort, like the hint itself. Whoever commits a generation calls this
// too, so a reader near the publisher starts from the new one.
export async function writeHint(username: string, siteId: string, meta: SiteMeta): Promise<void> {
  try {
    await caches.default.put(hintRequest(username, siteId), new Response(JSON.stringify(hintOf(meta)), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=2592000" },
    }));
  } catch {
    /* no hint: the next request waits for the record, as it always could */
  }
}
