import { useEffect } from "react";
import { useHomeConfig } from "./useHomeConfig";

/**
 * PWA 文档元数据同步（不碰 manifest blob）
 *
 * - `<link rel="manifest">` 始终指向同源 `/manifest.json`（Chrome 可安装性）
 * - 开发环境在内容管理器保存时，Vite 中间件会把远程图标裁成 192/512 写入 public 并更新 manifest.json
 * - 此处只同步 title / meta / favicon / apple-touch-icon 为当前配置
 */
export function useDynamicManifest() {
  const { config } = useHomeConfig();

  useEffect(() => {
    if (!config) return;

    const { desktopIcon, appBranding } = config;
    const appName =
      desktopIcon?.appName || appBranding?.appName || "DVA Bolivia";
    const slogan =
      appBranding?.slogan || "GO FUTURE.TOGETHER";

    const manifestLink = document.querySelector(
      'link[rel="manifest"]',
    ) as HTMLLinkElement | null;
    if (manifestLink) {
      manifestLink.href = new URL("/manifest.json", window.location.origin).href;
    }

    document.title = appName;

    const setMeta = (name: string, content: string) => {
      const m = document.querySelector(
        `meta[name="${name}"]`,
      ) as HTMLMetaElement | null;
      if (m) m.content = content;
    };
    setMeta("apple-mobile-web-app-title", appName);
    setMeta("application-name", appName);
    setMeta("description", `${appName} - ${slogan}`);

    const ogTitle = document.querySelector(
      'meta[property="og:title"]',
    ) as HTMLMetaElement | null;
    if (ogTitle) ogTitle.content = appName;
    const ogDesc = document.querySelector(
      'meta[property="og:description"]',
    ) as HTMLMetaElement | null;
    if (ogDesc) ogDesc.content = slogan;
    const ogImg = document.querySelector(
      'meta[property="og:image"]',
    ) as HTMLMetaElement | null;
    if (ogImg) {
      ogImg.content = `${window.location.origin}/icon-512.png`;
    }

    const iconHref = "/icon-192.png";
    const apple = document.querySelector(
      'link[rel="apple-touch-icon"]',
    ) as HTMLLinkElement | null;
    if (apple) {
      apple.href = iconHref;
      apple.type = "image/png";
    }
    const fav = document.querySelector(
      'link[rel="icon"]',
    ) as HTMLLinkElement | null;
    if (fav) {
      fav.href = iconHref;
      fav.type = "image/png";
    }
  }, [config]);
}
