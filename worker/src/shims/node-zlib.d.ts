// The slice of node:zlib gunzipStream uses (workerd implements it natively under
// nodejs_compat). Declared here instead of pulling @types/node, whose globals
// would shadow @cloudflare/workers-types the way lib.dom does (see README).
declare module "node:zlib" {
  interface Gunzip {
    write(chunk: Uint8Array): boolean;
    end(): void;
    pause(): void;
    resume(): void;
    destroy(error?: unknown): void;
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "drain" | "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    once(event: "drain", listener: () => void): this;
  }
  export function createGunzip(options?: { chunkSize?: number }): Gunzip;
}
