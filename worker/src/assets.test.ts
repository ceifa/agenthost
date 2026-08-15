import { describe, expect, it } from "vitest";
import { attachmentDisposition, safeAssetName } from "./assets";
import { signDirectDownload, signDirectUpload } from "./r2-signed";
import { assetDownloadHtml } from "./templates";
import type { Env } from "./env";

const env = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "assets-bucket",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
} as Env;

describe("direct R2 asset transfer", () => {
  it("signs an exact-size PUT straight to R2", async () => {
    const signed = await signDirectUpload(env, "assets/user/id/blob", {
      bytes: 757_603_783,
      contentType: "video/mp4",
      contentDisposition: attachmentDisposition("Universe.mp4"),
    });
    const url = new URL(signed.url);

    expect(url.host).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/assets-bucket/assets/user/id/blob");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-disposition;content-length;content-type;host",
    );
    expect(signed.headers["content-length"]).toBe("757603783");
    expect(signed.headers["content-type"]).toBe("video/mp4");
  });

  it("signs downloads on R2 rather than the Worker origin", async () => {
    const signed = await signDirectDownload(env, "assets/user/id/blob");
    const page = assetDownloadHtml({
      name: "Universe.mp4",
      bytes: 757_603_783,
      contentType: "video/mp4",
      downloadUrl: signed.url,
      shareUrl: "https://agenthost.page/a/user/id?k=secret",
    });

    expect(signed.url).toContain(".r2.cloudflarestorage.com/");
    expect(page).toContain(`href="${signed.url.replace(/&/g, "&amp;")}"`);
    expect(page).not.toContain("/download");
    expect(page).toContain(">Download</a>");
  });

  it("sanitizes names before putting them in metadata and headers", () => {
    expect(safeAssetName("../folder/video final.mp4")).toBe("video final.mp4");
    expect(safeAssetName("bad\r\nname.mp4")).toBeNull();
    expect(attachmentDisposition("vídeo final.mp4")).toContain("filename*=UTF-8''v%C3%ADdeo%20final.mp4");
  });
});
