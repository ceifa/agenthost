// Streaming gunzip tolerant of trailing bytes after the gzip member.
//
// We can't use the platform `DecompressionStream("gzip")`: macOS `bsdtar czf -`
// to a pipe (the canonical publish command) appends zero-padding after the gzip
// member, which DecompressionStream rejects outright — discarding all output.
// fflate emits the whole valid member before throwing on the trailing garbage,
// so we forward that output and treat a post-output error as clean EOF. Tar's
// zero-block terminator is the real integrity check downstream.

import { Gunzip } from "fflate";

export function gunzipStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  let producedAny = false;
  let gz: Gunzip;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      gz = new Gunzip((chunk) => {
        if (chunk.length) {
          producedAny = true;
          controller.enqueue(chunk);
        }
      });
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        try {
          gz.push(done ? new Uint8Array(0) : value!, done);
        } catch (e) {
          // Trailing padding after a complete member is fine; a throw before any
          // output is real corruption and must surface.
          if (producedAny) {
            controller.close();
            await reader.cancel();
            return;
          }
          throw e;
        }
        if (done) controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}
