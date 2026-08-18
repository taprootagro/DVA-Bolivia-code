// ============================================================================
// imageCompressor — 通用图片压缩工具
// ============================================================================
// 面向非洲低端设备 + 有限移动数据设计：
// - 使用 canvas 缩放 + WebP/JPEG 压缩（默认 WebP）
// - 支持 base64 data URL 和 File/Blob 两种输入
// - GIF 动图不在此压缩（由调用方原样上传）
// ============================================================================

export type ImageOutputFormat = "webp" | "jpeg";

export interface CompressOptions {
  /** 最长边最大像素，默认 1280 */
  maxSize?: number;
  /** 质量 0-1，默认 0.75 */
  quality?: number;
  /** 压缩后最大字节数（近似），若首次压缩后仍超出则降质量重试 */
  maxBytes?: number;
  /** 输出格式，默认 webp；不支持 WebP 的浏览器自动降级 JPEG */
  format?: ImageOutputFormat;
  /** 降质量重试次数（默认 3） */
  maxQualityAttempts?: number;
  /** true 时跳过「已够小则 readAsDataURL」快速路径，强制 canvas 重编码（去 EXIF） */
  forceReencode?: boolean;
}

/** AI 云端识图统一上限（深度分析 + 追问带图共用） */
export const AI_VISION_IMAGE_LIMITS = {
  maxSize: 1024,
  quality: 0.75,
  maxBytes: 250 * 1024,
} as const;

/** 估算 data URL 解码后的字节数（base64 约 4/3 → ×0.75） */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(b64.length * 0.75);
}

/** 预设场景 */
export const COMPRESS_PRESETS = {
  /** 聊天图片：病虫害特写，全屏放大可读 */
  chat: {
    maxSize: 1280,
    quality: 0.72,
    maxBytes: 220 * 1024,
    format: "webp" as const,
    maxQualityAttempts: 5,
    forceReencode: true,
  } as CompressOptions,
  /** AI 识别：与 AI_VISION_IMAGE_LIMITS 对齐 */
  ai: {
    maxSize: AI_VISION_IMAGE_LIMITS.maxSize,
    quality: AI_VISION_IMAGE_LIMITS.quality,
    maxBytes: AI_VISION_IMAGE_LIMITS.maxBytes,
    format: "webp" as const,
  } as CompressOptions,
  /** 头像/小图 */
  avatar: { maxSize: 512, quality: 0.7, maxBytes: 80 * 1024, format: "webp" as const } as CompressOptions,
  /** 资料页头像上传：更小体积，避免 user_profiles.avatar_url 过大 */
  profileAvatar: { maxSize: 384, quality: 0.62, maxBytes: 55 * 1024, format: "webp" as const } as CompressOptions,
  /** 内容管理器富文本正文插图：先压缩再上传 cms-public，控制 app_config 体积 */
  richArticle: { maxSize: 1920, quality: 0.82, maxBytes: 1_200 * 1024, format: "webp" as const } as CompressOptions,
  /** CMS 通用字段上传（banner、封面等）；手机全宽 2x 约 960px 宽 + ≤150KB WebP */
  cmsUpload: { maxSize: 960, quality: 0.82, maxBytes: 150 * 1024, format: "webp" as const } as CompressOptions,
} as const;

let webpEncodeSupported: boolean | null = null;

/** 检测当前浏览器 canvas 是否支持 WebP 编码 */
export function isWebpEncodeSupported(): boolean {
  if (webpEncodeSupported !== null) return webpEncodeSupported;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    webpEncodeSupported = canvas.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpEncodeSupported = false;
  }
  return webpEncodeSupported;
}

function resolveMime(format: ImageOutputFormat): string {
  if (format === "webp" && isWebpEncodeSupported()) return "image/webp";
  return "image/jpeg";
}

function extFromMime(mime: string): string {
  return mime === "image/webp" ? "webp" : "jpg";
}

/**
 * 压缩 base64 data URL 图片
 */
export function compressImageBase64(
  base64: string,
  options: CompressOptions = {},
): Promise<string> {
  const {
    maxSize = 1280,
    quality = 0.75,
    maxBytes,
    format = "webp",
    maxQualityAttempts = 3,
  } = options;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const result = compressFromImage(img, maxSize, quality, maxBytes, format, maxQualityAttempts);
      const origKB = Math.round(base64.length * 0.75 / 1024);
      const compKB = Math.round(result.length * 0.75 / 1024);
      if (compKB < origKB) {
        console.log(
          `[ImageCompressor] ${img.naturalWidth}x${img.naturalHeight} → compressed, ${origKB}KB → ${compKB}KB (${Math.round((1 - compKB / origKB) * 100)}% saved)`,
        );
      }
      resolve(result);
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

/**
 * 压缩 File 对象为 base64 data URL
 */
export function compressImageFile(
  file: File | Blob,
  options: CompressOptions = {},
): Promise<string> {
  const {
    maxSize = 1280,
    quality = 0.75,
    maxBytes,
    format = "webp",
    maxQualityAttempts = 3,
    forceReencode = false,
  } = options;
  const mime = resolveMime(format);

  return new Promise((resolve, reject) => {
    if (
      !forceReencode &&
      maxBytes &&
      file.size <= maxBytes &&
      file.type === mime
    ) {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
      return;
    }

    loadImageBitmap(file)
      .then((bitmap) => {
        const result = compressFromBitmap(bitmap, maxSize, quality, maxBytes, format, maxQualityAttempts);
        const compKB = Math.round(result.length * 0.75 / 1024);
        const origKB = Math.round(file.size / 1024);
        console.log(
          `[ImageCompressor] File ${origKB}KB (${bitmap.width}x${bitmap.height}) → ${compKB}KB (${Math.round((1 - compKB / origKB) * 100)}% saved)`,
        );
        bitmap.close();
        resolve(result);
      })
      .catch(() => {
        const reader = new FileReader();
        reader.onload = (e) => {
          compressImageBase64(e.target?.result as string, options).then(resolve);
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
  });
}

/**
 * 压缩 File 并返回 File 对象（用于 storage 上传）
 */
export async function compressImageFileToFile(
  file: File,
  options: CompressOptions = {},
): Promise<File> {
  const dataUrl = await compressImageFile(file, options);
  const mime = resolveMime(options.format ?? "webp");
  const ext = extFromMime(mime);
  const baseName = file.name.replace(/\.[^.]+$/, "") || "upload";
  return dataUrlToImageFile(dataUrl, `${baseName}.${ext}`);
}

/** data URL → File，保留 data URL 中的 MIME */
export async function dataUrlToImageFile(dataUrl: string, fileName: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const mimeMatch = /^data:([^;]+)/.exec(dataUrl);
  const type = mimeMatch?.[1] || blob.type || "image/webp";
  return new File([blob], fileName, { type });
}

/** 是否应跳过压缩（GIF 动图原样上传） */
export function shouldSkipImageCompression(file: File | Blob): boolean {
  const t = (file.type || "").toLowerCase();
  return t === "image/gif";
}

// ── 内部实现 ──────────────────────────────────────────────────

/** createImageBitmap with EXIF orientation when supported */
function loadImageBitmap(file: File | Blob): Promise<ImageBitmap> {
  const opts = { imageOrientation: "from-image" as const };
  try {
    return createImageBitmap(file, opts);
  } catch {
    return createImageBitmap(file);
  }
}

function canvasToDataUrl(
  canvas: HTMLCanvasElement,
  quality: number,
  format: ImageOutputFormat,
): string {
  const mime = resolveMime(format);
  return canvas.toDataURL(mime, quality);
}

function compressFromImage(
  img: HTMLImageElement,
  maxSize: number,
  quality: number,
  maxBytes: number | undefined,
  format: ImageOutputFormat,
  maxQualityAttempts = 3,
): string {
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  if (w <= maxSize && h <= maxSize && !maxBytes) {
    return img.src;
  }

  if (w > maxSize || h > maxSize) {
    if (w > h) {
      h = Math.round((h * maxSize) / w);
      w = maxSize;
    } else {
      w = Math.round((w * maxSize) / h);
      h = maxSize;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);

  let result = canvasToDataUrl(canvas, quality, format);

  if (maxBytes) {
    result = reduceQualityUntilUnderMax(
      canvas,
      result,
      quality,
      maxBytes,
      format,
      maxQualityAttempts,
    );
  }

  return result;
}

function compressFromBitmap(
  bitmap: ImageBitmap,
  maxSize: number,
  quality: number,
  maxBytes: number | undefined,
  format: ImageOutputFormat,
  maxQualityAttempts = 3,
): string {
  let w = bitmap.width;
  let h = bitmap.height;

  if (w > maxSize || h > maxSize) {
    if (w > h) {
      h = Math.round((h * maxSize) / w);
      w = maxSize;
    } else {
      w = Math.round((w * maxSize) / h);
      h = maxSize;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);

  let result = canvasToDataUrl(canvas, quality, format);

  if (maxBytes) {
    result = reduceQualityUntilUnderMax(
      canvas,
      result,
      quality,
      maxBytes,
      format,
      maxQualityAttempts,
    );
  }

  return result;
}

function reduceQualityUntilUnderMax(
  canvas: HTMLCanvasElement,
  initial: string,
  quality: number,
  maxBytes: number,
  format: ImageOutputFormat,
  maxAttempts: number,
): string {
  let result = initial;
  let currentBytes = Math.round(result.length * 0.75);
  let q = quality;
  let attempts = 0;
  while (currentBytes > maxBytes && q > 0.25 && attempts < maxAttempts) {
    q -= 0.15;
    attempts++;
    result = canvasToDataUrl(canvas, q, format);
    currentBytes = Math.round(result.length * 0.75);
  }
  return result;
}
