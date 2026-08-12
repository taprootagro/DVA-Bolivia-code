// ============================================================================
// merchant-bind-resolve — account-based QR resolver
// ============================================================================
// GET /merchant-bind-resolve?token=<merchant_user_id_uuid>
//
// **农户身份仅以 JWT 为准**（Authorization: Bearer <用户 access_token>，不得传 anon key）。
// 查询参数不再接受 farmerUserId（旧客户端若传会被忽略；防伪造）。
//
// QR content: https://<verified-domain>/m/<merchant_user_id_uuid>[?day=YYYY-MM-DD&sig=<hmac>]
//   - token = merchant Supabase auth user id (UUID)
//   - 可选 HMAC：MERCHANT_BIND_REQUIRE_SIG=true 时须带 day（当日 UTC）与 sig，
//     sig = base64url(HMAC-SHA256(MERCHANT_BIND_HMAC_SECRET, merchant_id|day))；门店用 merchant-bind-qr-url 生成。
//   - 日配额（可选）：MERCHANT_BIND_MAX_NEW_MERCHANTS_PER_FARMER_PER_DAY、
//     MERCHANT_BIND_MAX_NEW_FARMERS_PER_MERCHANT_PER_DAY（0=不限制）
//
// Server-side work:
//   1. Look up merchant's display profile from user_profiles (must exist, app_role=distributor)
//   2. Allocate or reuse channel_id in merchant_farmer_channels keyed by
//      (merchant_user_id, farmer_user_id).
//   3. Mirror into farmer_merchant_bindings (ON CONFLICT DO NOTHING) so the
//      farmer can recover chatContact on a new device via RLS SELECT.
//
// Response JSON:
//   { ok: true, merchantUserId, channelId, name, avatar, subtitle, imProvider: 'supabase' }
//
// Depends on migrations/001_init.sql (merchant_farmer_channels + farmer_merchant_bindings).
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

/** 拒绝把 anon key 当作用户 JWT */
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
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!anonKey || !url) return null;
  const client = bearerUserClient(jwt);
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(Deno.env.get(key) || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function utcDateYmd(): string {
  const n = new Date();
  const y = n.getUTCFullYear();
  const mo = String(n.getUTCMonth() + 1).padStart(2, "0");
  const d = String(n.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function utcDayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  ));
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
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

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function maxNewMerchantsPerFarmerDay(): number {
  const v = parseInt(
    Deno.env.get("MERCHANT_BIND_MAX_NEW_MERCHANTS_PER_FARMER_PER_DAY") || "0",
    10,
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function maxNewFarmersPerMerchantDay(): number {
  const v = parseInt(
    Deno.env.get("MERCHANT_BIND_MAX_NEW_FARMERS_PER_MERCHANT_PER_DAY") || "0",
    10,
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function verifyMerchantBindSignature(
  reqUrl: string,
  merchantUserId: string,
): Promise<Response | null> {
  const requireSig = Deno.env.get("MERCHANT_BIND_REQUIRE_SIG") === "true";
  const secret = (Deno.env.get("MERCHANT_BIND_HMAC_SECRET") || "").trim();
  if (requireSig && !secret) {
    console.error("[merchant-bind-resolve] MERCHANT_BIND_REQUIRE_SIG without MERCHANT_BIND_HMAC_SECRET");
    return json({ ok: false, error: "SERVER_MISCONFIGURED" }, 500);
  }
  if (!requireSig) return null;

  const url = new URL(reqUrl);
  const day = (url.searchParams.get("day") || "").trim();
  const sig = (url.searchParams.get("sig") || "").trim();
  if (!day || !sig || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json({ ok: false, error: "INVALID_BIND_SIG" }, 403);
  }
  if (day !== utcDateYmd()) {
    return json({
      ok: false,
      error: "BIND_SIG_EXPIRED",
      retry_after_seconds: secondsUntilUtcMidnight(),
    }, 403);
  }
  const payload = `${merchantUserId}|${day}`;
  const expected = await hmacSha256B64Url(secret, payload);
  if (!timingSafeEqualStr(sig, expected)) {
    return json({ ok: false, error: "INVALID_BIND_SIG" }, 403);
  }
  return null;
}

async function enforceBindDailyQuotas(
  admin: SupabaseClient,
  merchantUserId: string,
  farmerUserId: string,
): Promise<Response | null> {
  const start = utcDayStartIso();
  const maxF = maxNewMerchantsPerFarmerDay();
  if (maxF > 0) {
    const { count, error } = await admin
      .from("merchant_farmer_channels")
      .select("id", { count: "exact", head: true })
      .eq("farmer_user_id", farmerUserId)
      .gte("created_at", start);
    if (error) {
      console.warn("[merchant-bind-resolve] quota farmer count", error);
    } else if ((count ?? 0) >= maxF) {
      return json({
        ok: false,
        error: "BIND_QUOTA_FARMER",
        retry_after_seconds: secondsUntilUtcMidnight(),
      }, 429);
    }
  }
  const maxM = maxNewFarmersPerMerchantDay();
  if (maxM > 0) {
    const { count, error } = await admin
      .from("merchant_farmer_channels")
      .select("id", { count: "exact", head: true })
      .eq("merchant_user_id", merchantUserId)
      .gte("created_at", start);
    if (error) {
      console.warn("[merchant-bind-resolve] quota merchant count", error);
    } else if ((count ?? 0) >= maxM) {
      return json({
        ok: false,
        error: "BIND_QUOTA_MERCHANT",
        retry_after_seconds: secondsUntilUtcMidnight(),
      }, 429);
    }
  }
  return null;
}

function merchantBindRlEnabled(): boolean {
  return Deno.env.get("MERCHANT_BIND_RL_ENABLED") !== "false";
}

/** 每用户每分钟尝试次数（merchant_bind_rl 表） */
async function enforceMerchantBindRateLimit(
  admin: SupabaseClient,
  userId: string,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  if (!merchantBindRlEnabled()) return { ok: true };

  const perMin = envInt("MERCHANT_BIND_RL_PER_MIN", 20);
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await admin
    .from("merchant_bind_rl")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gt("created_at", since);

  if (error) {
    console.warn("[merchant-bind-resolve] merchant_bind_rl count", error);
    return { ok: true };
  }
  if ((count ?? 0) >= perMin) {
    return { ok: false, retryAfter: 60 };
  }

  const { error: insErr } = await admin.from("merchant_bind_rl").insert({ user_id: userId });
  if (insErr) {
    console.warn("[merchant-bind-resolve] merchant_bind_rl insert", insErr);
  }
  return { ok: true };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUuid(raw: string | null): string | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s || !UUID_RE.test(s)) return null;
  return s;
}

interface MerchantProfile {
  name: string;
  avatar: string;
  subtitle: string;
}

function extractMerchantProfile(
  profile: unknown,
  columnName?: string | null,
  columnAvatar?: string | null,
): MerchantProfile {
  const p = (profile && typeof profile === "object")
    ? (profile as Record<string, unknown>)
    : {};
  const asStr = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name =
    (columnName && asStr(columnName)) ||
    asStr(p.name) ||
    asStr(p.displayName) ||
    asStr(p.full_name) ||
    asStr(p.nickname) ||
    "";
  const avatar =
    (columnAvatar && asStr(columnAvatar)) ||
    asStr(p.avatar) ||
    asStr(p.avatar_url) ||
    asStr(p.picture) ||
    "";
  const subtitle =
    asStr(p.subtitle) ||
    asStr(p.bio) ||
    asStr(p.description) ||
    "";
  return { name, avatar, subtitle };
}

/** 仅插入新行；调用方已确认无现有绑定并已通过日配额。 */
async function allocateNewChannelRow(
  admin: ReturnType<typeof createClient>,
  merchantUserId: string,
  farmerUserId: string,
): Promise<{ channelId: string | null; error: string | null }> {
  const channelId = crypto.randomUUID();
  const { error: insErr } = await admin.from("merchant_farmer_channels").insert({
    merchant_user_id: merchantUserId,
    farmer_user_id: farmerUserId,
    channel_id: channelId,
  });

  if (!insErr) {
    return { channelId, error: null };
  }

  if (String(insErr.code) === "23505" || insErr.message?.includes("duplicate")) {
    const { data: again, error: againErr } = await admin
      .from("merchant_farmer_channels")
      .select("channel_id")
      .eq("merchant_user_id", merchantUserId)
      .eq("farmer_user_id", farmerUserId)
      .maybeSingle();
    if (againErr || !again?.channel_id) {
      console.error("[merchant-bind-resolve] retry select", againErr);
      return { channelId: null, error: "Channel allocation failed" };
    }
    return { channelId: String(again.channel_id), error: null };
  }

  console.error("[merchant-bind-resolve] insert merchant_farmer_channels", insErr);
  return { channelId: null, error: "Channel allocation failed" };
}

async function mirrorFarmerBinding(
  admin: ReturnType<typeof createClient>,
  farmerUserId: string,
  merchantUserId: string,
  channelId: string,
): Promise<void> {
  const { error } = await admin
    .from("farmer_merchant_bindings")
    .upsert(
      {
        farmer_user_id: farmerUserId,
        merchant_user_id: merchantUserId,
        channel_id: channelId,
      },
      { onConflict: "farmer_user_id,merchant_user_id", ignoreDuplicates: true },
    );
  if (error) {
    console.warn("[merchant-bind-resolve] mirror farmer_merchant_bindings", error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return err("Method not allowed", 405);
  }

  const url = new URL(req.url);
  const merchantUserId = normalizeUuid(url.searchParams.get("token"));

  if (!merchantUserId) {
    return err("Missing or invalid token (expect merchant user id UUID)", 400);
  }

  const jwt = extractUserJwt(req);
  if (!jwt) {
    return err("Unauthorized: sign in and send Authorization: Bearer <access_token> (not anon key)", 401);
  }

  const authFarmerId = await getAuthUserId(jwt);
  if (!authFarmerId) {
    return err("Unauthorized: invalid or expired session", 401);
  }

  const farmerUserId = authFarmerId.toLowerCase();
  if (merchantUserId === farmerUserId) {
    return err("Cannot bind to yourself", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return err("Server misconfigured", 500);
  }

  const admin = adminClient();

  const rl = await enforceMerchantBindRateLimit(admin, farmerUserId);
  if (!rl.ok) {
    return json(
      { ok: false, error: "RATE_LIMIT", retry_after_seconds: rl.retryAfter },
      429,
    );
  }

  const sigBlock = await verifyMerchantBindSignature(req.url, merchantUserId);
  if (sigBlock) return sigBlock;

  // 1. 校验 merchant 存在、app_role=distributor，并加载显示资料
  const { data: profileRow, error: profErr } = await admin
    .from("user_profiles")
    .select("profile, display_name, avatar_url, app_role")
    .eq("user_id", merchantUserId)
    .maybeSingle();

  if (profErr) {
    console.error("[merchant-bind-resolve] user_profiles", profErr);
    return err("Merchant lookup failed", 500);
  }
  if (!profileRow) {
    return err("Merchant not found", 404);
  }
  if (profileRow.app_role !== "distributor") {
    return err("Forbidden: merchant is not a distributor", 403);
  }

  const { name, avatar, subtitle } = extractMerchantProfile(
    profileRow.profile,
    profileRow.display_name as string | null | undefined,
    profileRow.avatar_url as string | null | undefined,
  );

  // 2. 分配/复用 channel
  const { data: existingBind, error: bindSelErr } = await admin
    .from("merchant_farmer_channels")
    .select("channel_id")
    .eq("merchant_user_id", merchantUserId)
    .eq("farmer_user_id", farmerUserId)
    .maybeSingle();

  if (bindSelErr) {
    console.error("[merchant-bind-resolve] select merchant_farmer_channels", bindSelErr);
    return err("Channel lookup failed", 500);
  }

  let channelId: string;
  if (existingBind?.channel_id) {
    channelId = String(existingBind.channel_id);
  } else {
    const qerr = await enforceBindDailyQuotas(admin, merchantUserId, farmerUserId);
    if (qerr) return qerr;
    const alloc = await allocateNewChannelRow(admin, merchantUserId, farmerUserId);
    if (alloc.error || !alloc.channelId) {
      return err(alloc.error || "Channel allocation failed", 500);
    }
    channelId = alloc.channelId;
  }

  // 3. 镜像到 farmer 可读表（跨设备恢复）
  await mirrorFarmerBinding(admin, farmerUserId, merchantUserId, channelId);

  return json({
    ok: true,
    merchantUserId,
    channelId,
    name,
    avatar,
    subtitle,
    imProvider: "supabase",
  });
});
