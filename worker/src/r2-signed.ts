// SigV4 presigning for direct R2 transfers. The Worker signs control-plane
// requests only; asset bytes travel client ↔ R2 and never cross the Worker.

import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export interface SignedUpload {
  url: string;
  headers: Record<string, string>;
  expiresIn: number;
}

function credentials(env: Env): AwsClient {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("direct R2 uploads are not configured");
  }
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

function objectUrl(env: Env, key: string): URL {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME) {
    throw new Error("direct R2 uploads are not configured");
  }
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}/${encodedKey}`,
  );
}

async function presign(
  env: Env,
  key: string,
  method: "GET" | "PUT",
  expiresIn: number,
  headers?: Record<string, string>,
): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await credentials(env).sign(url, {
    method,
    headers,
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

export async function signDirectUpload(
  env: Env,
  key: string,
  opts: { bytes: number; contentType: string; contentDisposition: string; expiresIn?: number },
): Promise<SignedUpload> {
  const expiresIn = opts.expiresIn ?? 15 * 60;
  const headers = {
    "content-length": String(opts.bytes),
    "content-type": opts.contentType,
    "content-disposition": opts.contentDisposition,
  };
  return { url: await presign(env, key, "PUT", expiresIn, headers), headers, expiresIn };
}

export async function signDirectDownload(
  env: Env,
  key: string,
  expiresIn = 5 * 60,
): Promise<{ url: string; expiresIn: number }> {
  return { url: await presign(env, key, "GET", expiresIn), expiresIn };
}
