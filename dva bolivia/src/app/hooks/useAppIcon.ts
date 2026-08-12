import { useState, useEffect } from "react";

/**
 * useAppIcon — 自动探测 /public 下的应用图标（PNG 优先，SVG 兜底）
 * 返回可直接用于 <img src> 的路径，全部探测失败时返回 null
 */

const CANDIDATES = ["/icon-192.png", "/icon-192.svg"];

let cachedUrl: string | null = null;
let probed = false;

function probeIcon(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

export function useAppIcon(): string | null {
  const [iconUrl, setIconUrl] = useState<string | null>(cachedUrl);

  useEffect(() => {
    if (probed) return;
    probed = true;
    let cancelled = false;
    (async () => {
      for (const candidate of CANDIDATES) {
        if (await probeIcon(candidate)) {
          cachedUrl = candidate;
          if (!cancelled) setIconUrl(candidate);
          return;
        }
      }
      // 全部失败 → 保持 null，让调用方显示 emoji 兜底
    })();
    return () => { cancelled = true; };
  }, []);

  return iconUrl;
}
