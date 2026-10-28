// SigV4 presigning for direct R2 uploads. The Worker signs control-plane
// requests only; upload bytes travel client → R2 and never cross the Worker.

import { AwsClient } from "aws4fetch";
import type { Env } from "./env";
import { encodePath } from "./ids";

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
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}/${encodePath(key)}`,
  );
}

export async function signDirectUpload(
  env: Env,
  key: string,
  opts: { bytes: number; contentType: string; expiresIn: number; etag?: string },
): Promise<SignedUpload> {
  const headers: Record<string, string> = {
    "content-length": String(opts.bytes),
    "content-type": opts.contentType,
    ...(opts.etag ? { "if-match": opts.etag } : { "if-none-match": "*" }),
  };
  const url = objectUrl(env, key);
  url.searchParams.set("X-Amz-Expires", String(opts.expiresIn));
  const signed = await credentials(env).sign(url, {
    method: "PUT",
    headers,
    aws: { signQuery: true, allHeaders: true },
  });
  return { url: signed.url, headers, expiresIn: opts.expiresIn };
}
