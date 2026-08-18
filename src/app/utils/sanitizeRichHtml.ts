import DOMPurify from "dompurify";
import { isAllowedVideoIframeSrc } from "./videoEmbedFromUrl";
import {
  rewriteCmsMediaUrlsInHtml,
  type MediaUrlResolveConfig,
} from "./resolveMediaUrl";

let videoIframeHookInstalled = false;

function installVideoIframeAllowlist() {
  if (videoIframeHookInstalled) return;
  videoIframeHookInstalled = true;
  DOMPurify.addHook("uponSanitizeElement", (node) => {
    if (node.nodeName === "IFRAME") {
      const src = (node as HTMLIFrameElement).getAttribute("src");
      if (!src || !isAllowedVideoIframeSrc(src)) {
        (node as HTMLElement).remove();
        return;
      }
    }
    if (node.nodeName === "DIV") {
      const el = node as HTMLElement;
      if ((el.getAttribute("data-youtube-video") != null || el.getAttribute("data-cms-embed") != null) && !el.querySelector("iframe")) {
        el.remove();
      }
    }
  });
}

/**
 * 远程配置 / CMS 下发的 HTML，在 dangerouslySetInnerHTML 前必须经过消毒。
 * TipTap 输出：textStyle 颜色/字号、mark 高亮、pre/code、blockquote、
 * 嵌入视频 div[data-youtube-video] / div[data-cms-embed] + iframe（仅允许白名单 src）。
 */
export function sanitizeRichHtml(html: string): string {
  if (!html?.trim()) return "";
  installVideoIframeAllowlist();
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: [
      "target",
      "rel",
      "data-align",
      "data-color",
      "data-youtube-video",
      "data-cms-embed",
      "width",
      "height",
      "colspan",
      "rowspan",
      "scope",
      "class",
      "allow",
      "allowfullscreen",
      "title",
      "frameborder",
      "loading",
      "referrerpolicy",
    ],
    ADD_TAGS: ["mark", "thead", "tbody", "tfoot", "iframe", "div"],
    FORBID_TAGS: ["script", "object", "embed", "base", "link"],
  });
}

/** Sanitize CMS HTML and rewrite relative media paths for display. */
export function sanitizeRichHtmlWithMedia(
  html: string,
  mediaConfig?: MediaUrlResolveConfig | null,
): string {
  const clean = sanitizeRichHtml(html);
  if (!clean || !mediaConfig) return clean;
  return rewriteCmsMediaUrlsInHtml(clean, mediaConfig);
}
