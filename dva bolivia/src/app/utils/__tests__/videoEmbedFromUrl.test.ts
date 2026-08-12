import { describe, expect, it } from "vitest";
import {
  buildEmbedPlaybackSrc,
  getNonYoutubeEmbedUrl,
  getYoutubeEmbedUrl,
  isAllowedVideoIframeSrc,
  resolveLiveStreamEmbedUrl,
} from "../videoEmbedFromUrl";

describe("buildEmbedPlaybackSrc", () => {
  it("adds autoplay and playsinline for YouTube embed", () => {
    const base = getYoutubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!;
    const out = buildEmbedPlaybackSrc(base, true);
    const u = new URL(out);
    expect(u.searchParams.get("autoplay")).toBe("1");
    expect(u.searchParams.get("playsinline")).toBe("1");
  });

  it("removes autoplay when pausing", () => {
    const base = getYoutubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!;
    const playing = buildEmbedPlaybackSrc(base, true);
    const paused = buildEmbedPlaybackSrc(playing, false);
    const u = new URL(paused);
    expect(u.searchParams.has("autoplay")).toBe(false);
  });

  it("adds autoplay for Bilibili embed", () => {
    const base = resolveLiveStreamEmbedUrl("https://www.bilibili.com/video/BV1xx411c7mD")!;
    const out = buildEmbedPlaybackSrc(base, true);
    expect(new URL(out).searchParams.get("autoplay")).toBe("1");
  });

  it("adds autoplay for Vimeo embed", () => {
    const base = resolveLiveStreamEmbedUrl("https://vimeo.com/123456789")!;
    const out = buildEmbedPlaybackSrc(base, true);
    expect(new URL(out).searchParams.get("autoplay")).toBe("1");
  });

  it("adds autoplay for Facebook embed", () => {
    const base = resolveLiveStreamEmbedUrl("https://www.facebook.com/watch/?v=10153231379946729")!;
    const out = buildEmbedPlaybackSrc(base, true);
    expect(new URL(out).searchParams.get("autoplay")).toBe("1");
  });
});

describe("tryParseFacebook via resolveLiveStreamEmbedUrl", () => {
  it("resolves facebook watch URLs", () => {
    const url = resolveLiveStreamEmbedUrl("https://www.facebook.com/watch/?v=10153231379946729");
    expect(url).toContain("www.facebook.com/plugins/video.php");
    expect(url).toContain(encodeURIComponent("https://www.facebook.com/watch/?v=10153231379946729"));
  });

  it("resolves facebook page videos URLs", () => {
    const url = resolveLiveStreamEmbedUrl("https://www.facebook.com/PlayStation/videos/10155554431506803/");
    expect(url).toContain("plugins/video.php");
    expect(url).toContain(encodeURIComponent("https://www.facebook.com/PlayStation/videos/10155554431506803/"));
  });

  it("resolves facebook reel URLs", () => {
    const url = resolveLiveStreamEmbedUrl("https://www.facebook.com/reel/1234567890123456");
    expect(url).toContain("plugins/video.php");
    expect(url).toContain(encodeURIComponent("https://www.facebook.com/reel/1234567890123456"));
  });

  it("resolves fb.watch short links", () => {
    const url = resolveLiveStreamEmbedUrl("https://fb.watch/abc123/");
    expect(url).toContain("plugins/video.php");
    expect(url).toContain(encodeURIComponent("https://fb.watch/abc123"));
  });

  it("normalizes m.facebook.com URLs", () => {
    const url = resolveLiveStreamEmbedUrl("https://m.facebook.com/watch/?v=10153231379946729");
    expect(url).toContain(encodeURIComponent("https://www.facebook.com/watch/?v=10153231379946729"));
  });
});

describe("isAllowedVideoIframeSrc Facebook", () => {
  it("allows facebook plugin URLs", () => {
    const embed = getNonYoutubeEmbedUrl("https://www.facebook.com/watch/?v=10153231379946729")!;
    expect(isAllowedVideoIframeSrc(embed)).toBe(true);
  });

  it("rejects raw facebook watch page URLs", () => {
    expect(isAllowedVideoIframeSrc("https://www.facebook.com/watch/?v=10153231379946729")).toBe(false);
  });
});
