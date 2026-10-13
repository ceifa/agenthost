// The slices of node:child_process, node:fs, node:os and node:path the installer
// test uses to run install.sh (vitest runs under Node). Declared here for the
// same reason as node-zlib.d.ts: @types/node would shadow @cloudflare/workers-types.
declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options?: { input?: string }): Uint8Array;
}
declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, options?: { mode?: number }): void;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}
