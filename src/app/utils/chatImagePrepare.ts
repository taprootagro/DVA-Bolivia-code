// ============================================================================
// chatImagePrepare — 社区聊天发图：校验 → 压缩 → 硬上限拒绝
// ============================================================================

import {
  COMPRESS_PRESETS,
  compressImageFile,
  estimateDataUrlBytes,
  type CompressOptions,
} from "./imageCompressor";

/** 与服务端 chat-supabase MAX_IMAGE 对齐 */
export const CHAT_IMAGE_SERVER_MAX_BYTES = 12 * 1024 * 1024;

export const CHAT_IMAGE_LIMITS = {
  maxSize: 1280,
  quality: 0.72,
  targetMaxBytes: 220 * 1024,
  hardMaxBytes: 480 * 1024,
  format: "webp" as const,
  maxQualityAttempts: 5,
} as const;

export type ChatImageErrorCode =
  | "unsupported"
  | "too_large"
  | "process_failed";

export type ChatImagePrepareResult =
  | { ok: true; dataUrl: string }
  | { ok: false; code: ChatImageErrorCode };

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const CHAT_COMPRESS_OPTIONS: CompressOptions = {
  ...COMPRESS_PRESETS.chat,
};

function normalizeMime(type: string): string {
  const t = (type || "").toLowerCase().split(";")[0].trim();
  if (t === "image/jpg") return "image/jpeg";
  return t;
}

function validateChatImageMime(mime: string): ChatImageErrorCode | null {
  const t = normalizeMime(mime);
  if (t === "image/gif") return "unsupported";
  if (t.startsWith("video/")) return "unsupported";
  if (!ALLOWED_MIME.has(t)) return "unsupported";
  return null;
}

function validateRawSize(size: number): ChatImageErrorCode | null {
  if (size > CHAT_IMAGE_SERVER_MAX_BYTES) return "too_large";
  return null;
}

function checkHardMax(dataUrl: string): ChatImageErrorCode | null {
  if (estimateDataUrlBytes(dataUrl) > CHAT_IMAGE_LIMITS.hardMaxBytes) {
    return "too_large";
  }
  return null;
}

async function compressForChat(source: File | Blob): Promise<string> {
  return compressImageFile(source, CHAT_COMPRESS_OPTIONS);
}

/** PWA / file input */
export async function prepareChatImageFromFile(
  file: File,
): Promise<ChatImagePrepareResult> {
  const mimeErr = validateChatImageMime(file.type);
  if (mimeErr) return { ok: false, code: mimeErr };

  const sizeErr = validateRawSize(file.size);
  if (sizeErr) return { ok: false, code: sizeErr };

  try {
    const dataUrl = await compressForChat(file);
    const hardErr = checkHardMax(dataUrl);
    if (hardErr) return { ok: false, code: hardErr };
    return { ok: true, dataUrl };
  } catch (e) {
    console.warn("[chatImagePrepare] compress file failed", e);
    return { ok: false, code: "process_failed" };
  }
}

/** Capacitor camera / data URL */
export async function prepareChatImageFromDataUrl(
  dataUrl: string,
): Promise<ChatImagePrepareResult> {
  const mimeMatch = /^data:([^;,]+)/i.exec(dataUrl);
  const mime = mimeMatch?.[1] || "image/jpeg";
  const mimeErr = validateChatImageMime(mime);
  if (mimeErr) return { ok: false, code: mimeErr };

  const approxBytes = estimateDataUrlBytes(dataUrl);
  const sizeErr = validateRawSize(approxBytes);
  if (sizeErr) return { ok: false, code: sizeErr };

  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const dataUrlOut = await compressForChat(blob);
    const hardErr = checkHardMax(dataUrlOut);
    if (hardErr) return { ok: false, code: hardErr };
    return { ok: true, dataUrl: dataUrlOut };
  } catch (e) {
    console.warn("[chatImagePrepare] compress dataUrl failed", e);
    return { ok: false, code: "process_failed" };
  }
}

/** Map error code → i18n key on t.community */
export function chatImageErrorMessageKey(
  code: ChatImageErrorCode,
): "chatImageUnsupported" | "chatImageTooLarge" | "chatImageProcessFailed" {
  switch (code) {
    case "unsupported":
      return "chatImageUnsupported";
    case "too_large":
      return "chatImageTooLarge";
    case "process_failed":
      return "chatImageProcessFailed";
  }
}
