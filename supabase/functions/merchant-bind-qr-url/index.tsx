// ============================================================================
// merchant-bind-qr-url — 门店登录后获取当日可扫码的绑定 URL 路径（含 HMAC）
// ============================================================================
// GET /merchant-bind-qr-url
// Authorization: Bearer <门店用户 access_token>
// Requires user_profiles.app_role = distributor (and profile row exists).
//
// 当项目配置了 MERCHANT_BIND_HMAC_SECRET 时，返回 pathQuery = /m/<merchant_uuid>?day=YYYY-MM-DD&sig=...
// 否则返回 /m/<merchant_uuid>（仅在不强制 MERCHANT_BIND_REQUIRE_SIG 时可用）。
// ============================================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.49.8";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function bearerUserClient(jwt: string): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );
}

function extractUserJwt(req: Request): string | null {
  const raw = (req.headers.get("Authorization") || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  const token = m?.[1]?.trim();
  if (!token) return null;
  const anon = (Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
  if (anon && token === anon) return null;
  return token;
}

async function getAuthUserId(jwt: string): Promise<string | null> {
  const client = bearerUserClient(jwt);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function utcDateYmd(): string {
  const n = new Date();
  const y = n.getUTCFullYear();
  const mo = String(n.getUTCMonth() + 1).padStart(2, "0");
  const d = String(n.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function base64urlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256B64Url(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64urlEncode(sig);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return err("Method not allowed", 405);
  }

  const jwt = extractUserJwt(req);
  if (!jwt) {
    return err("Unauthorized: Bearer <access_token> required", 401);
  }
  const merchantUserId = await getAuthUserId(jwt);
  if (!merchantUserId) {
    return err("Unauthorized: invalid session", 401);
  }
  const mid = merchantUserId.toLowerCase();
  if (!UUID_RE.test(mid)) {
    return err("Invalid user id", 400);
  }

  const admin = adminClient();
  const { data: profileRow, error: profErr } = await admin
    .from("user_profiles")
    .select("app_role")
    .eq("user_id", mid)
    .maybeSingle();
  if (profErr) {
    console.error("[merchant-bind-qr-url] user_profiles", profErr);
    return err("Profile lookup failed", 500);
  }
  if (!profileRow) {
    return err("Profile not found", 404);
  }
  if (profileRow.app_role !== "distributor") {
    return err("Forbidden: distributor app_role required", 403);
  }

  const secret = (Deno.env.get("MERCHANT_BIND_HMAC_SECRET") || "").trim();
  if (!secret) {
    const pathQuery = `/m/${mid}`;
    return json({
      ok: true,
      merchantUserId: mid,
      pathQuery,
      signed: false,
    });
  }

  const day = utcDateYmd();
  const payload = `${mid}|${day}`;
  const sig = await hmacSha256B64Url(secret, payload);
  const pathQuery =
    `/m/${mid}?day=${encodeURIComponent(day)}&sig=${encodeURIComponent(sig)}`;

  return json({
    ok: true,
    merchantUserId: mid,
    pathQuery,
    signed: true,
    day,
  });
});
