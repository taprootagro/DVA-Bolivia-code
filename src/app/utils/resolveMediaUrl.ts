import type { BackendProxyConfig } from "../hooks/useHomeConfig";
import { CMS_PUBLIC_BUCKET } from "./cmsPublicUpload";

export type MediaUrlResolveConfig = Pick<
  BackendProxyConfig,
  "mediaCdnBaseUrl" | "supabaseUrl"
>;

/** Encode object key segments for URL path (matches Edge joinPublicObjectUrl). */
export function encodeObjectKeyPath(objectKey: string): string {
  return objectKey
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Supabase Storage public object URL for cms-public bucket. */
export function buildSupabaseCmsPublicUrl(
  supabaseUrl: string,
  objectPath: string,
): string {
  const base = supabaseUrl.trim().replace(/\/+$/, "");
  if (!base || base.includes("your-")) return "";
  const key = objectPath.trim().replace(/^\/+/, "");
  if (!key) return "";
  return `${base}/storage/v1/object/public/${CMS_PUBLIC_BUCKET}/${encodeObjectKeyPath(key)}`;
}

function isAbsoluteMediaUrl(value: string): boolean {
  const v = value.trim();
  return /^https?:\/\//i.test(v) || v.startsWith("data:");
}

function isPlaceholderSupabaseUrl(url: string): boolean {
  const u = url.trim();
  return !u || u.includes("your-");
}

/**
 * Resolve a CMS media value for display.
 * - Absolute http(s) / data: URLs pass through unchanged.
 * - Relative storage paths → mediaCdnBaseUrl when set, else Supabase public URL.
 */
export function resolveMediaUrl(
  value: string | null | undefined,
  config?: MediaUrlResolveConfig | null,
): string {
  if (value == null) return "";
  const raw = value.trim();
  if (!raw) return "";

  if (isAbsoluteMediaUrl(raw)) return raw;

  const path = raw.replace(/^\/+/, "");
  if (!path) return raw;

  const cdnBase = (config?.mediaCdnBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (cdnBase) {
    return `${cdnBase}/${encodeObjectKeyPath(path)}`;
  }

  const supaUrl = (config?.supabaseUrl ?? "").trim();
  if (!isPlaceholderSupabaseUrl(supaUrl)) {
    const built = buildSupabaseCmsPublicUrl(supaUrl, path);
    if (built) return built;
  }

  return raw;
}

/** Rewrite relative CMS media URLs inside sanitized HTML (img/video/source src). */
export function rewriteCmsMediaUrlsInHtml(
  html: string,
  config?: MediaUrlResolveConfig | null,
): string {
  if (!html?.trim() || typeof document === "undefined") return html;

  const tpl = document.createElement("template");
  tpl.innerHTML = html;

  const tags = tpl.content.querySelectorAll("img[src], video[src], source[src]");
  tags.forEach((el) => {
    const attr = el.getAttribute("src");
    if (!attr || isAbsoluteMediaUrl(attr)) return;
    const resolved = resolveMediaUrl(attr, config);
    if (resolved && resolved !== attr) el.setAttribute("src", resolved);
  });

  return tpl.innerHTML;
}
