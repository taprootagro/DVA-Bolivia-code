import { presignS3PutUrl } from "./s3PresignedPut.ts";

export type CmsS3PresignBody = {
  provider: string;
  fileName: string;
  contentType: string;
  byteSize: number;
};

const ALLOWED_CT = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
]);

const IMAGE_CT = /^image\//;

const CMS_MAX_BYTES_IMAGE = 25 * 1024 * 1024;
const CMS_MAX_BYTES_VIDEO = 200 * 1024 * 1024;

function normalizeMime(ct: string): string {
  const s = ct.trim().toLowerCase();
  if (s === "image/jpg") return "image/jpeg";
  return s;
}

/** Match client cmsPublicUpload.sanitizeCmsFileName */
export function sanitizeCmsFilenameServer(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return base || "upload.bin";
}

/** Build final URL exposed to browsers (CDN / custom domain + encoded path). */
export function joinPublicObjectUrl(publicBase: string, objectKey: string): string {
  const b = publicBase.trim().replace(/\/+$/, "");
  const tail = objectKey.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${b}/${tail}`;
}

export type CmsPresignOk = {
  method: "PUT";
  uploadUrl: string;
  publicUrl: string;
  headers: Record<string, string>;
};

/** Returns structured error messages for Edge json({ error }). */
export async function cmsS3Presign(
  body: CmsS3PresignBody,
  userId: string,
): Promise<{ ok: true; data: CmsPresignOk } | { ok: false; error: string; status: number }> {
  const { provider, fileName: rawName, contentType: rawCt, byteSize } = body;

  if (!provider || !rawCt || typeof byteSize !== "number" || !Number.isFinite(byteSize)) {
    return { ok: false, error: "Invalid body: provider, fileName, contentType, byteSize required", status: 400 };
  }

  const normalizedCt = normalizeMime(rawCt);

  if (!ALLOWED_CT.has(normalizedCt)) {
    return { ok: false, error: "Content-Type not allowed for CMS upload", status: 400 };
  }

  const maxBytes = IMAGE_CT.test(normalizedCt) ? CMS_MAX_BYTES_IMAGE : CMS_MAX_BYTES_VIDEO;
  if (byteSize <= 0 || byteSize > maxBytes) {
    return { ok: false, error: `File too large or empty (max ${maxBytes} bytes for this type)`, status: 400 };
  }

  const safe = sanitizeCmsFilenameServer(rawName || "upload.bin");
  const objectKey = `content/${userId}/${Date.now()}-${safe}`;

  try {
    if (provider === "cloudflare_r2") {
      const accountId = (Deno.env.get("CMS_R2_ACCOUNT_ID") || "").trim();
      const accessKey = (Deno.env.get("CMS_R2_ACCESS_KEY_ID") || "").trim();
      const secretKey = (Deno.env.get("CMS_R2_SECRET_ACCESS_KEY") || "").trim();
      const bucket = (Deno.env.get("CMS_R2_BUCKET") || "").trim();
      const publicBase = (Deno.env.get("CMS_R2_PUBLIC_BASE_URL") || "").trim();
      if (!accountId || !accessKey || !secretKey || !bucket || !publicBase) {
        return { ok: false, error: "R2 CMS secrets not configured (CMS_R2_*)", status: 503 };
      }
      const region = (Deno.env.get("CMS_R2_REGION") || "auto").trim();
      const endpointOrigin = `https://${accountId}.r2.cloudflarestorage.com`;
      const signed = await presignS3PutUrl({
        endpointOrigin,
        region,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        bucket,
        objectKey,
        contentType: normalizedCt,
        expiresSeconds: 900,
        forcePathStyle: true,
      });

      const publicUrl = joinPublicObjectUrl(publicBase, objectKey);
      return {
        ok: true,
        data: {
          method: "PUT",
          uploadUrl: signed.url,
          publicUrl,
          headers: {
            "Content-Type": normalizedCt,
            "x-amz-date": signed.amzDate,
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
          },
        },
      };
    }

    if (provider === "aliyun_oss") {
      const accessKey = (Deno.env.get("CMS_ALIYUN_ACCESS_KEY_ID") || "").trim();
      const secretKey = (Deno.env.get("CMS_ALIYUN_ACCESS_KEY_SECRET") || "").trim();
      const bucket = (Deno.env.get("CMS_ALIYUN_BUCKET") || "").trim();
      const region = (Deno.env.get("CMS_ALIYUN_REGION") || "").trim();
      let endpointOrigin = (Deno.env.get("CMS_ALIYUN_ENDPOINT") || "").trim();
      const publicBase = (Deno.env.get("CMS_ALIYUN_PUBLIC_BASE_URL") || "").trim();
      if (!accessKey || !secretKey || !bucket || !region || !publicBase) {
        return { ok: false, error: "Aliyun OSS CMS secrets incomplete (CMS_ALIYUN_*)", status: 503 };
      }
      if (!endpointOrigin) {
        endpointOrigin = `https://oss-${region}.aliyuncs.com`;
      }
      const signed = await presignS3PutUrl({
        endpointOrigin: endpointOrigin.replace(/\/+$/, ""),
        region,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        bucket,
        objectKey,
        contentType: normalizedCt,
        expiresSeconds: 900,
        forcePathStyle: false,
      });
      const publicUrl = joinPublicObjectUrl(publicBase, objectKey);
      return {
        ok: true,
        data: {
          method: "PUT",
          uploadUrl: signed.url,
          publicUrl,
          headers: {
            "Content-Type": normalizedCt,
            "x-amz-date": signed.amzDate,
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
          },
        },
      };
    }

    if (provider === "tencent_cos") {
      const accessKey = (Deno.env.get("CMS_TENCENT_SECRET_ID") || "").trim();
      const secretKey = (Deno.env.get("CMS_TENCENT_SECRET_KEY") || "").trim();
      const bucket = (Deno.env.get("CMS_TENCENT_BUCKET") || "").trim();
      const region = (Deno.env.get("CMS_TENCENT_REGION") || "").trim();
      let endpointOrigin = (Deno.env.get("CMS_TENCENT_ENDPOINT") || "").trim();
      const publicBase = (Deno.env.get("CMS_TENCENT_PUBLIC_BASE_URL") || "").trim();
      if (!accessKey || !secretKey || !bucket || !region || !publicBase) {
        return { ok: false, error: "Tencent COS CMS secrets incomplete (CMS_TENCENT_*)", status: 503 };
      }
      if (!endpointOrigin) {
        endpointOrigin = `https://cos.${region}.myqcloud.com`;
      }
      const signed = await presignS3PutUrl({
        endpointOrigin: endpointOrigin.replace(/\/+$/, ""),
        region,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        bucket,
        objectKey,
        contentType: normalizedCt,
        expiresSeconds: 900,
        forcePathStyle: true,
      });
      const publicUrl = joinPublicObjectUrl(publicBase, objectKey);
      return {
        ok: true,
        data: {
          method: "PUT",
          uploadUrl: signed.url,
          publicUrl,
          headers: {
            "Content-Type": normalizedCt,
            "x-amz-date": signed.amzDate,
            "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
          },
        },
      };
    }

    return { ok: false, error: "Unknown provider", status: 400 };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cms/presign] error:", msg);
    return { ok: false, error: "Presign failed", status: 500 };
  }
}
