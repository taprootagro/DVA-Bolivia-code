import { useState } from "react";
import { resolveLiveStreamEmbedUrl } from "../utils/videoEmbedFromUrl";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";

const EMBED_IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen";

type Props = {
  videoUrl: string;
  /** 用作 poster / 加载失败时回退 */
  posterUrl?: string;
  alt?: string;
  /** 与外层 `relative overflow-hidden` 容器配合，一般为 absolute inset-0 */
  className?: string;
};

/**
 * 详情页顶部：可选视频 + poster；平台分享链接走 iframe，直链走 video；失败时回退为图片。
 */
export function DetailHeroVideo({ videoUrl, posterUrl, alt = "", className = "absolute inset-0 h-full w-full" }: Props) {
  const [failed, setFailed] = useState(false);
  const { resolve } = useCmsMediaUrl();
  const v = videoUrl.trim();
  if (!v) return null;

  const embedUrl = resolveLiveStreamEmbedUrl(v);
  const resolvedPoster = posterUrl ? resolve(posterUrl) : undefined;
  const resolvedVideo = embedUrl ? v : resolve(v);

  if (embedUrl) {
    return (
      <>
        {resolvedPoster && (
          <img
            src={resolvedPoster}
            alt=""
            aria-hidden
            className={`${className} object-cover opacity-40 blur-sm pointer-events-none`}
          />
        )}
        <iframe
          src={embedUrl}
          title={alt || "Video"}
          className={`${className} object-cover bg-black z-[1] border-0`}
          allow={EMBED_IFRAME_ALLOW}
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </>
    );
  }

  if (failed) {
    if (resolvedPoster) {
      return (
        <img
          src={resolvedPoster}
          alt={alt}
          className={`${className} object-fill bg-gray-100`}
        />
      );
    }
    return <div className={`${className} flex items-center justify-center bg-gray-100 text-gray-400 text-xs`} />;
  }

  return (
    <video
      src={resolvedVideo}
      poster={resolvedPoster || undefined}
      controls
      playsInline
      preload="metadata"
      className={`${className} object-cover bg-black`}
      onError={() => setFailed(true)}
    />
  );
}
