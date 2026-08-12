import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { resolveLiveStreamEmbedUrl } from "../utils/videoEmbedFromUrl";

type CmsTranslateFn = (...args: [string, string] | [string, string, string]) => string;

type Props = {
  videoUrl?: string;
  ct: CmsTranslateFn;
  /** live 分支用缩略图提示；轮播/文章/产品用详情页提示 */
  hintVariant?: "live" | "detail";
};

/**
 * CMS 编辑表单：videoUrl 嵌入识别提示与 iframe 预览（YouTube / Vimeo / B 站 / Facebook）。
 */
export function CmsVideoUrlEmbedPreview({ videoUrl, ct, hintVariant = "detail" }: Props) {
  const raw = (videoUrl || "").trim();
  if (!raw) return null;

  const embed = resolveLiveStreamEmbedUrl(raw);
  if (embed) {
    return (
      <div className="mt-2 space-y-2">
        <p className="text-xs text-emerald-600 flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {ct("messages.live_embed_detected", "已识别为嵌入视频，播放页将以 iframe 展示", "Embedded video detected — playback page will use an iframe")}
        </p>
        <div className="relative w-full max-w-xs aspect-video rounded-lg overflow-hidden border border-gray-200 bg-black">
          <iframe
            src={embed}
            title={ct("messages.live_embed_detected", "已识别为嵌入视频，播放页将以 iframe 展示", "Embedded video detected — playback page will use an iframe")}
            className="absolute inset-0 w-full h-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    );
  }

  const looksLikeHttp = /^https?:\/\//i.test(raw);
  if (!looksLikeHttp) {
    return (
      <p className="mt-1 text-xs text-amber-600 flex items-center gap-1">
        <AlertTriangle className="w-3.5 h-3.5" />
        {ct("messages.live_video_url_unrecognized", "无法识别为嵌入视频，将按直链视频播放", "Not recognized as an embed — will play as a direct video URL")}
      </p>
    );
  }

  if (hintVariant === "live") {
    return (
      <p className="mt-1 text-xs text-gray-400">
        {ct("messages.thumbnail_for_list_cover_display_video_url_for", "缩略图用于列表封面展示，视频URL用于播放页面", "Thumbnail for list cover display, Video URL for playback page")}
      </p>
    );
  }

  return (
    <p className="mt-1 text-xs text-gray-400">
      {ct("将按直链视频播放", "Will play as a direct video URL")}
    </p>
  );
}
