/**
 * Minimal AWS SigV4 query-string auth presigned PUT URL for S3-compatible APIs
 * (Cloudflare R2, Tencent COS, Aliyun OSS in S3 compatibility mode).
 */
const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function hmacSha256(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(encoder.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export type PresignS3PutOpts = {
  /** Origin only, no path, e.g. https://123abc.r2.cloudflarestorage.com */
  endpointOrigin: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Object key, no leading slash */
  objectKey: string;
  contentType: string;
  expiresSeconds: number;
  forcePathStyle: boolean;
};

/**
 * Builds X-Amz-Signature query param and returns full presigned PUT URL.
 * Client MUST send PUT with identical Content-Type, Host implied by URL,
 * and headers x-amz-content-sha256: UNSIGNED-PAYLOAD, x-amz-date (same value as query).
 *
 * Browser fetch may set Host automatically — for cross-origin PUT to storage,
 * omit manually setting Host; some S3 providers accept signature with host from URL only.
 *
 * IMPORTANT: `@aws-sdk` clients inject x-amz-date; browsers often do NOT.
 * S3 verifies signed headers presence — we sign content-type + host + x-amz-content-sha256 + x-amz-date.
 * When using XMLHttpRequest/fetch cross-origin to R2/COS/OSS bucket URL, Host header is set by the browser
 * to the presigned URL's host — must match headerHostValue used at sign time (OK).
 *
 * Required extra headers on client PUT:
 * - Content-Type: (same as presign)
 * - x-amz-content-sha256: UNSIGNED-PAYLOAD
 * - x-amz-date: (must match query X-Amz-Date exactly)
 */
export async function presignS3PutUrl(opts: PresignS3PutOpts): Promise<{ url: string; amzDate: string }> {
  const ep = opts.endpointOrigin.replace(/\/+$/, "");
  const u = new URL(ep);

  /** YYYYMMDDTHHmmssZ */
  const amzDate =
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

  const dateStamp = amzDate.slice(0, 8);

  const keyParts = opts.objectKey.split("/").filter(Boolean).map(encodeRfc3986);
  const encodedKeyPath = keyParts.join("/");

  let canonicalUri: string;
  let headerHostValue: string;
  if (opts.forcePathStyle) {
    canonicalUri =
      "/" + encodeRfc3986(opts.bucket) + "/" + encodedKeyPath;
    canonicalUri = canonicalUri.replace(/\/+/g, "/");
    headerHostValue = u.host;
  } else {
    canonicalUri = "/" + encodedKeyPath;
    headerHostValue = `${opts.bucket}.${u.host}`;
  }

  const service = "s3";
  const credentialScope = `${dateStamp}/${opts.region}/${service}/aws4_request`;

  const algorithm = "AWS4-HMAC-SHA256";
  const expires = Math.min(Math.max(opts.expiresSeconds, 120), 15 * 60);

  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `content-type:${opts.contentType}\n` +
    `host:${headerHostValue}\n` +
    `x-amz-content-sha256:UNSIGNED-PAYLOAD\n` +
    `x-amz-date:${amzDate}\n`;

  const sortedParams: [string, string][] = [
    ["X-Amz-Algorithm", algorithm],
    ["X-Amz-Credential", `${opts.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ].sort(([a], [b]) => a.localeCompare(b));

  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest =
    [
      "PUT",
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");

  const hashCanon = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(canonicalRequest),
  );

  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n${toHex(hashCanon)}`;

  const signingKey = await getSignatureKey(
    opts.secretAccessKey,
    dateStamp,
    opts.region,
    service,
  );
  const sig = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(sig);

  const queryOut = canonicalQueryString + "&X-Amz-Signature=" + signature;

  const url =
    opts.forcePathStyle
      ? `${ep}${canonicalUri}?${queryOut}`
      : `https://${headerHostValue}${canonicalUri}?${queryOut}`;

  return { url, amzDate };
}
