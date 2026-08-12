/**
 * Word / 富 HTML 粘贴：清洗、保留常用格式；内嵌 data: 图可上传为 cms-public URL。
 */

import { uploadFileToCmsPublic } from "./cmsPublicUpload";
import { getServerUserId } from "./auth";

const MAX_CMS_IMAGE_BYTES = 15 * 1024 * 1024;

type CleanOpts = { stripDataImages: boolean };

/** 浅色/白色文字（常配合深色底在 Word/网页 中出现）；去背景后应一并去掉，否则在白纸上看不见 */
function isLightForegroundColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "white") return true;
  if (v === "#fff" || v === "#ffffff") return true;
  const m = v.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
  if (m) {
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    if (r >= 245 && g >= 245 && b >= 245) return true;
  }
  if (/^#[0-9a-f]{3,6}$/i.test(v)) {
    const hex = v.length === 4 ? `#${v[1]!}${v[1]!}${v[2]!}${v[2]!}${v[3]!}${v[3]!}` : v;
    if (hex.length === 7) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 0xff;
      const g = (n >> 8) & 0xff;
      const b = n & 0xff;
      if (r >= 245 && g >= 245 && b >= 245) return true;
    }
  }
  return false;
}

/**
 * 单行 style 里「我们保留」：去掉 Word/底纹/反白块等；保留字体大小、行高、颜色（在合理时）等。
 */
function cleanInlineStyleString(styles: string): string {
  const parts = styles
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const entries: { k: string; v: string }[] = [];
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    const v = p.slice(i + 1).trim();
    entries.push({ k, v });
  }
  const hadBackground = entries.some(
    (e) => e.k === "background" || e.k.startsWith("background-") || e.k === "mso-shading",
  );
  const next = entries.filter((e) => {
    if (!e.k) return false;
    if (e.k.startsWith("mso-")) return false;
    if (e.k === "tab-stops" || e.k.startsWith("tab-stops")) return false;
    if (e.k === "font-family") return false;
    if (e.k.startsWith("language")) return false;
    if (e.k === "background" || e.k.startsWith("background-") || e.k === "mso-shading") return false;
    if (e.k === "box-shadow" || e.k === "text-shadow" || e.k === "filter") return false;
    if (e.k === "color" && hadBackground && isLightForegroundColor(e.v)) return false;
    return true;
  });
  if (!next.length) return "";
  return next.map((e) => `${e.k}: ${e.v}`).join("; ");
}

/**
 * 去除 Word/网页 噪音，保留 font-size、color、加粗/斜体/下划、行高等（去掉 mso-*、font-family 等杂项）
 */
export function cleanWordHtml(raw: string, opts: CleanOpts = { stripDataImages: true }): string {
  let html = raw;
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<(style|script|xml|meta|link|title|head)[\s\S]*?<\/\1>/gi, "");
  html = html.replace(
    /<\/?(style|script|xml|meta|link|title|head|html|body|o:\w+|v:\w+|w:\w+)[^>]*>/gi,
    "",
  );
  html = html.replace(/\s*class="[^"]*"/gi, "");
  html = html.replace(/\s*style="([^"]*)"/gi, (_m, styles: string) => {
    const cleaned = cleanInlineStyleString(styles);
    return cleaned ? ` style="${cleaned}"` : "";
  });
  html = html.replace(/<span[^>]*>\s*<\/span>/gi, "");
  html = html.replace(/(\s*\n\s*)+/g, "\n");
  html = html.replace(/<p[^>]*>\s*<\/p>/gi, "");
  if (opts.stripDataImages) {
    html = html.replace(/<img[^>]+src="data:[^"]+"[^>]*\/?>/gi, "");
  }
  return html.trim();
}

/**
 * 将 data: 内嵌图压缩并上传，替换为 https。未登录时返回去掉内嵌图并清洗后的 HTML。
 */
export async function convertDataImagesInHtmlToCms(
  rawHtml: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  if (!getServerUserId()) {
    return cleanWordHtml(rawHtml, { stripDataImages: true });
  }
  if (!rawHtml || !/src=["']data:image/i.test(rawHtml)) {
    return cleanWordHtml(rawHtml, { stripDataImages: true });
  }
  if (typeof document === "undefined") {
    return cleanWordHtml(rawHtml, { stripDataImages: true });
  }
  const pre = cleanWordHtml(rawHtml, { stripDataImages: false });
  const doc = new DOMParser().parseFromString(pre, "text/html");
  const list = Array.from(doc.querySelectorAll("img")).filter((n) => {
    const s = (n as HTMLImageElement).getAttribute("src") || "";
    return s.startsWith("data:");
  });
  const total = list.length;
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const img = list[i] as HTMLImageElement;
    const dataUrl = img.getAttribute("src") || "";
    try {
      const rough = (dataUrl.length * 0.75) / 1;
      if (rough > MAX_CMS_IMAGE_BYTES) {
        img.remove();
        done += 1;
        onProgress?.(done, total);
        continue;
      }
      const b = await fetch(dataUrl).then((r) => r.blob());
      const inFile = new File([b], `word-img-${i}.${(b.type?.split("/")[1] || "png").split("+")[0]}`, {
        type: b.type || "image/png",
      });
      if (inFile.size > MAX_CMS_IMAGE_BYTES) {
        img.remove();
        done += 1;
        onProgress?.(done, total);
        continue;
      }
      const result = await uploadFileToCmsPublic(inFile);
      if (result.ok) {
        img.setAttribute("src", result.storagePath);
        img.removeAttribute("width");
      } else {
        img.remove();
      }
    } catch {
      img.remove();
    }
    done += 1;
    onProgress?.(done, total);
  }
  return cleanWordHtml(doc.body.innerHTML, { stripDataImages: true });
}
