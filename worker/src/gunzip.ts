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
  let produced = 0;
  let gz: Gunzip;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      gz = new Gunzip((chunk) => {
        if (chunk.length) {
          produced++;
          controller.enqueue(chunk);
        }
      });
    },
    async pull(controller) {
      // A pull that returns without enqueuing is never called again, and the
      // consumer's read hangs. Incompressible input (video, jpeg) deflates to
      // stored blocks that fflate holds until whole, so one input chunk often
      // inflates to nothing: keep feeding until something comes out.
      const before = produced;
      try {
        while (produced === before) {
          const { value, done } = await reader.read();
          try {
            gz.push(done ? new Uint8Array(0) : value!, done);
          } catch (e) {
            // Trailing padding after a complete member is fine; a throw before any
            // output is real corruption and must surface.
            if (produced) {
              controller.close();
              await reader.cancel();
              return;
            }
            throw e;
          }
          if (done) {
            controller.close();
            return;
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}
