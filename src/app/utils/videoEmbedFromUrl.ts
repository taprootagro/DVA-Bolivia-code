/**
 * 将用户粘贴的页面/分享链接规范为可放进 iframe 的 embed URL（仅允许主流站）。
 */

function tryParseVimeo(url: string): string | null {
  const t = url.trim();
  if (!/vimeo\.com/i.test(t)) return null;
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    if (u.hostname.includes("player.vimeo.com") && u.pathname.includes("/video/")) {
      return u.toString();
    }
    const m = u.pathname.match(/(\d{6,})/);
    if (m) return `https://player.vimeo.com/video/${m[1]}`;
  } catch {
    /*  */
  }
  return null;
}

function tryParseBilibili(url: string): string | null {
  const t = url.trim();
  if (!/bilibili\.com|b23\.tv/i.test(t)) return null;
  const bv = t.match(/(BV[0-9A-Za-z]+)/i);
  if (bv) {
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bv[1]!)}&page=1&high_quality=1&danmaku=0`;
  }
  if (t.includes("player.bilibili.com")) {
    return t.startsWith("http") ? t : `https:${t.startsWith("//") ? "" : "//"}${t}`;
  }
  return null;
}

function buildFacebookEmbedUrl(canonicalVideoUrl: string): string {
  const params = new URLSearchParams({
    href: canonicalVideoUrl,
    show_text: "false",
    width: "560",
  });
  return `https://www.facebook.com/plugins/video.php?${params.toString()}`;
}

function normalizeFacebookHost(url: URL): URL {
  const h = url.hostname.toLowerCase();
  if (h === "m.facebook.com" || h === "facebook.com" || h.endsWith(".facebook.com")) {
    url.hostname = "www.facebook.com";
  }
  return url;
}

function tryParseFacebook(url: string): string | null {
  const t = url.trim();
  if (!/facebook\.com|fb\.watch/i.test(t)) return null;
  try {
    const u = normalizeFacebookHost(new URL(t.startsWith("http") ? t : `https://${t}`));
    const h = u.hostname.toLowerCase();

    if (h.includes("facebook.com") && u.pathname.includes("/plugins/video.php")) {
      const href = u.searchParams.get("href");
      if (href) return buildFacebookEmbedUrl(href);
      return u.toString();
    }

    if (h === "fb.watch") {
      const short = u.toString().replace(/\/$/, "");
      return buildFacebookEmbedUrl(short);
    }

    let canonical: string | null = null;

    const watchV = u.searchParams.get("v");
    if (u.pathname.includes("/watch") && watchV && /^\d+$/.test(watchV)) {
      canonical = `https://www.facebook.com/watch/?v=${watchV}`;
    } else if (u.pathname.includes("video.php") && watchV && /^\d+$/.test(watchV)) {
      canonical = `https://www.facebook.com/video.php?v=${watchV}`;
    } else if (/^\/reel\/\d+/.test(u.pathname)) {
      canonical = `https://www.facebook.com${u.pathname.split("?")[0]}`;
    } else {
      const videosMatch = u.pathname.match(/(\/[^/]+\/videos\/\d+\/?)/);
      if (videosMatch) {
        const path = videosMatch[1]!.endsWith("/") ? videosMatch[1]! : `${videosMatch[1]!}/`;
        canonical = `https://www.facebook.com${path}`;
      }
    }

    if (canonical) return buildFacebookEmbedUrl(canonical);
  } catch {
    /*  */
  }
  return null;
}

/** 可交给 @tiptap/extension-youtube 的原始/页面 URL（与扩展内部校验一致，宽松检测）。 */
export function isYoutubeUserUrl(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  return /youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(t);
}

function extractYoutubeVideoId(url: string): string | null {
  const t = url.trim();
  if (!t || !isYoutubeUserUrl(t)) return null;
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    const h = u.hostname.toLowerCase();

    if (h === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0]?.split("?")[0];
      if (id && /^[\w-]{11}$/.test(id)) return id;
    }

    if ((h.includes("youtube.com") || h.includes("youtube-nocookie.com")) && u.pathname.startsWith("/embed/")) {
      const id = u.pathname.slice("/embed/".length).split("/")[0]?.split("?")[0];
      if (id && /^[\w-]{11}$/.test(id)) return id;
    }

    if (h.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;

      const shorts = u.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (shorts?.[1]) return shorts[1];

      const live = u.pathname.match(/^\/live\/([\w-]{11})/);
      if (live?.[1]) return live[1];
    }
  } catch {
    /*  */
  }
  return null;
}

/** 将 YouTube 页面/分享链接规范为 iframe embed URL（youtube-nocookie）。 */
export function getYoutubeEmbedUrl(url: string): string | null {
  const id = extractYoutubeVideoId(url);
  if (!id) return null;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

/**
 * 直播/视频 feed 统一 embed 解析：YouTube / Vimeo / B 站 / Facebook → iframe src；直链 MP4 等 → null。
 */
export function resolveLiveStreamEmbedUrl(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  if (isYoutubeUserUrl(t)) return getYoutubeEmbedUrl(t);
  return getNonYoutubeEmbedUrl(t);
}

/** 直播 feed iframe：在用户点击回调里同步改 src，避免 remount 丢失 user activation */
export function buildEmbedPlaybackSrc(base: string, autoplay: boolean): string {
  try {
    const u = new URL(base);
    if (autoplay) {
      u.searchParams.set("autoplay", "1");
      if (u.hostname.includes("youtube")) {
        u.searchParams.set("playsinline", "1");
      }
    } else {
      u.searchParams.delete("autoplay");
    }
    return u.toString();
  } catch {
    return base;
  }
}

/**
 * 非 YouTube 的 embed（Vimeo、B 站、Facebook 等），给 CmsOEmbed 节点用；YouTube 请用 setYoutubeVideo。
 */
export function getNonYoutubeEmbedUrl(url: string): string | null {
  if (isYoutubeUserUrl(url)) return null;
  return tryParseVimeo(url) ?? tryParseBilibili(url) ?? tryParseFacebook(url) ?? null;
}

/** sanitize 中 iframe 的 src 白名单（与编辑器插入逻辑一致） */
export function isAllowedVideoIframeSrc(src: string): boolean {
  try {
    const u = new URL(src.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "www.youtube.com" && u.pathname.startsWith("/embed/")) return true;
    if (h === "www.youtube-nocookie.com" && u.pathname.startsWith("/embed/")) return true;
    if (h === "player.vimeo.com" && u.pathname.startsWith("/video/")) return true;
    if (h === "player.bilibili.com") return true;
    if (h === "www.facebook.com" && u.pathname.startsWith("/plugins/video.php")) return true;
    return false;
  } catch {
    return false;
  }
}
