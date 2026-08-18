import { defaultConfig } from "/taprootagrosetting";
import type { CmsStorageProvider, HomePageConfig } from "../hooks/useHomeConfig";
import { CONFIG_STORAGE_KEY } from "../constants";
import { storageGetJSON } from "./safeStorage";
import { deepMerge, MERGE_REPLACE } from "./index";
import { getSupabaseBrowserClient } from "./supabaseBrowser";
import { getServerUserId, getAccessToken } from "./auth";
import {
  COMPRESS_PRESETS,
  compressImageFileToFile,
  shouldSkipImageCompression,
} from "./imageCompressor";

export const CMS_PUBLIC_BUCKET = "cms-public";

export function sanitizeCmsFileName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return base || "upload.bin";
}

function mergedHomeConfig(): HomePageConfig {
  const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  if (!parsed) return defaultConfig;
  return deepMerge(defaultConfig, parsed, MERGE_REPLACE) as HomePageConfig;
}

function effectiveCmsStorageProvider(): CmsStorageProvider {
  return mergedHomeConfig().backendProxyConfig?.cmsStorageProvider ?? "supabase";
}

function isStorageRlsDenied(err: { message?: string; statusCode?: string }): boolean {
  const msg = (err.message || "").toLowerCase();
  if (
    /row-level security|rls|violates row-level|new row violates|policy .* for table/i.test(
      msg,
    )
  ) {
    return true;
  }
  const code = String(err.statusCode ?? "");
  return code === "403" || code === "42501";
}

export type CmsPublicUploadResult =
  | { ok: true; storagePath: string }
  | { ok: false; error: string; rlsDenied?: boolean };

/** Derive storagePath from presign publicUrl (full URL or bare object key). */
function storagePathFromPresignPublicUrl(publicUrl: string): string {
  const u = publicUrl.trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) {
    try {
      const pathname = new URL(u).pathname.replace(/^\/+/, "");
      const contentIdx = pathname.indexOf("content/");
      if (contentIdx >= 0) return pathname.slice(contentIdx);
    } catch {
      /* fall through */
    }
    return u;
  }
  return u.replace(/^\/+/, "");
}

type PresignResponse = {
  method?: string;
  uploadUrl: string;
  publicUrl: string;
  headers: Record<string, string>;
};

async function uploadViaExternalPresign(
  file: File,
  provider: Exclude<CmsStorageProvider, "supabase">,
): Promise<CmsPublicUploadResult> {
  const bp = mergedHomeConfig().backendProxyConfig;
  const baseUrl = (bp?.supabaseUrl || "").trim().replace(/\/+$/, "");
  const anon = (bp?.supabaseAnonKey || "").trim();
  const efn = (bp?.edgeFunctionName || "server").replace(/^\//, "");
  const token = getAccessToken()?.trim();

  if (!baseUrl || baseUrl.includes("your-") || !anon) {
    return { ok: false, error: "Supabase project URL and anon key are required for CMS presign." };
  }
  if (!token) {
    return { ok: false, error: "Sign in required for external CMS storage upload." };
  }

  const presignUrl = `${baseUrl}/functions/v1/${efn}/cms/presign`;
  const contentType = (file.type && file.type.trim()) || "application/octet-stream";

  const res = await fetch(presignUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anon,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      provider,
      fileName: file.name,
      contentType,
      byteSize: file.size,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    let msg = raw || `Presign failed (${res.status})`;
    try {
      const j = JSON.parse(raw) as { error?: string };
      if (typeof j.error === "string") msg = j.error;
    } catch {
      /* keep msg */
    }
    return { ok: false, error: msg };
  }

  let data: PresignResponse;
  try {
    data = JSON.parse(raw) as PresignResponse;
  } catch {
    return { ok: false, error: "Invalid presign response" };
  }
  if (!data.uploadUrl || !data.publicUrl || !data.headers) {
    return { ok: false, error: "Incomplete presign response" };
  }

  const put = await fetch(data.uploadUrl, {
    method: (data.method || "PUT") as "PUT",
    headers: data.headers,
    body: file,
  });
  if (!put.ok) {
    const errBody = await put.text().catch(() => "");
    return {
      ok: false,
      error: `Storage upload failed (${put.status}): ${errBody.slice(0, 240)}`,
    };
  }

  const storagePath = storagePathFromPresignPublicUrl(data.publicUrl);
  if (!storagePath) {
    return { ok: false, error: "Could not derive storage path from presign response" };
  }
  return { ok: true, storagePath };
}

/**
 * Upload a CMS public file: Supabase Storage `cms-public`, or presigned PUT to R2/OSS/COS per config.
 * Static images (non-GIF) are compressed to WebP before upload.
 */
export async function uploadFileToCmsPublic(file: File): Promise<CmsPublicUploadResult> {
  let uploadFile = file;
  if (file.type.startsWith("image/") && !shouldSkipImageCompression(file)) {
    try {
      uploadFile = await compressImageFileToFile(file, COMPRESS_PRESETS.cmsUpload);
    } catch (e) {
      console.warn("[cmsPublicUpload] WebP compression failed, uploading original", e);
    }
  }

  const provider = effectiveCmsStorageProvider();

  if (provider !== "supabase") {
    return uploadViaExternalPresign(uploadFile, provider);
  }

  const client = getSupabaseBrowserClient();
  const uid = getServerUserId();
  if (!client || !uid) {
    return { ok: false, error: "Supabase sign-in required." };
  }
  const path = `content/${uid}/${Date.now()}-${sanitizeCmsFileName(uploadFile.name)}`;
  const { error: upErr } = await client.storage.from(CMS_PUBLIC_BUCKET).upload(path, uploadFile, {
    upsert: false,
    contentType: uploadFile.type || undefined,
  });
  if (upErr) {
    return {
      ok: false,
      error: upErr.message || String(upErr),
      rlsDenied: isStorageRlsDenied(upErr),
    };
  }
  return { ok: true, storagePath: path };
}
