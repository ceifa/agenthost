// Streaming gunzip tolerant of trailing bytes after the gzip member.
//
// Inflation runs in native zlib: on the Free plan a publish gets ~10 ms of CPU,
// and a JS inflater (fflate) spent several times that on a few MB. It has to be
// node:zlib, not `DecompressionStream`: `bsdtar czf -` to a pipe (the canonical
// publish command on macOS) zero-pads past the gzip member, and the web stream
// rejects trailing bytes by erroring, which throws away output still queued —
// the end of the archive. node:zlib ignores non-gzip bytes after a member, so
// padding passes and any error that remains is real corruption.

import { createGunzip } from "node:zlib";

export function gunzipStream(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  const gz = createGunzip({ chunkSize: 64 * 1024 });
  let settled = false;

  // Feed the body in as fast as zlib takes it.
  async function pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return gz.end();
        if (value?.byteLength && !gz.write(value)) await new Promise<void>((r) => gz.once("drain", r));
      }
    } catch (e) {
      gz.destroy(e);
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      gz.on("data", (chunk) => {
        if (settled) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 1) <= 0) gz.pause(); // resumed by pull
      });
      gz.on("end", () => {
        if (!settled) controller.close();
        settled = true;
      });
      gz.on("error", (e) => {
        if (!settled) controller.error(e);
        settled = true;
      });
      void pump();
    },
    pull() {
      gz.resume();
    },
    async cancel(reason) {
      settled = true;
      gz.destroy();
      await reader.cancel(reason);
    },
  });
}
