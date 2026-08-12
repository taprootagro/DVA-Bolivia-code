import { describe, expect, it } from "vitest";
import {
  buildSupabaseCmsPublicUrl,
  encodeObjectKeyPath,
  resolveMediaUrl,
} from "../resolveMediaUrl";

const SUPA = "https://api.topagro.com";
const CDN = "https://cdn.topagro.com/media";

describe("encodeObjectKeyPath", () => {
  it("encodes path segments", () => {
    expect(encodeObjectKeyPath("content/u1/a b.webp")).toBe(
      "content/u1/a%20b.webp",
    );
  });
});

describe("buildSupabaseCmsPublicUrl", () => {
  it("builds public storage URL", () => {
    expect(buildSupabaseCmsPublicUrl(SUPA, "content/u1/x.webp")).toBe(
      `${SUPA}/storage/v1/object/public/cms-public/content/u1/x.webp`,
    );
  });

  it("returns empty for placeholder URL", () => {
    expect(buildSupabaseCmsPublicUrl("https://your-project.supabase.co", "a")).toBe("");
  });
});

describe("resolveMediaUrl", () => {
  it("passes through absolute URLs", () => {
    const ext = "https://cdn.topagro.com/demo/photo-1.jpeg";
    expect(resolveMediaUrl(ext, { mediaCdnBaseUrl: CDN, supabaseUrl: SUPA })).toBe(ext);
  });

  it("passes through data URLs", () => {
    const data = "data:image/png;base64,abc";
    expect(resolveMediaUrl(data, { mediaCdnBaseUrl: CDN })).toBe(data);
  });

  it("uses CDN base when configured", () => {
    expect(
      resolveMediaUrl("content/u1/file.webp", {
        mediaCdnBaseUrl: CDN,
        supabaseUrl: SUPA,
      }),
    ).toBe(`${CDN}/content/u1/file.webp`);
  });

  it("falls back to Supabase public URL when CDN empty", () => {
    expect(
      resolveMediaUrl("content/u1/file.webp", {
        mediaCdnBaseUrl: "",
        supabaseUrl: SUPA,
      }),
    ).toBe(`${SUPA}/storage/v1/object/public/cms-public/content/u1/file.webp`);
  });

  it("returns raw path when no config", () => {
    expect(resolveMediaUrl("content/u1/x.webp", undefined)).toBe("content/u1/x.webp");
  });

  it("strips leading slashes on relative paths", () => {
    expect(
      resolveMediaUrl("/content/u1/x.webp", { mediaCdnBaseUrl: CDN }),
    ).toBe(`${CDN}/content/u1/x.webp`);
  });

  it("handles empty input", () => {
    expect(resolveMediaUrl("", { mediaCdnBaseUrl: CDN })).toBe("");
    expect(resolveMediaUrl(null, { mediaCdnBaseUrl: CDN })).toBe("");
  });
});
