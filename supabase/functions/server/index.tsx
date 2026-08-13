// ============================================================================
// Unified Edge Function — TaprootAgro PWA Backend
// ============================================================================
// This is the SINGLE Edge Function for the entire PWA.
// Each white-label deployment should deploy this to their own Supabase project.
//
// Endpoints:
//   GET  /server/health          — Health check
//   POST /server/send-code       — Send OTP verification code (phone/email)
//   POST /server/auth            — Verify OTP code + return userId & JWT
//   POST /server/oauth-exchange  — Exchange OAuth authorization code for token
//   POST /server/wechat/exchange   — WeChat OAuth2 code → openid → Supabase session (Secrets: WECHAT_*)
//   POST /server/alipay/exchange   — Alipay auth_code → user_id → Supabase session (Secrets: ALIPAY_*)
//   POST /server/line/exchange     — LINE OAuth2 code → userId → Supabase session (Secrets: LINE_CHANNEL_*)
//   GET  /server/profile         — Get user profile
//   POST /server/profile         — Save user profile
//   GET  /server/config          — Read remote app_config (optional Bearer user JWT: content_role admin/editor gets full JSON; others omit cloudAIConfig.systemPrompt)
//   POST /server/config          — Write remote app_config with optimistic locking
//   GET  /server/config/history  — List config version history (content admin JWT or CONFIG_WRITE_SECRET only)
//   POST /server/config/rollback — Rollback to a previous config version (content admin JWT or CONFIG_WRITE_SECRET only)
//   POST /server/push/subscribe   — Register Web Push / FCM / JPush token (user JWT + apikey)
//   POST /server/push/unsubscribe — Remove push registration
//   POST /server/push/send         — Broadcast push to all subscribers (content_admin/editor only)
//   POST /server/cms/presign     — S3-compatible presigned PUT for CMS media (Bearer user JWT + content_role admin/editor; Secrets CMS_R2_* / CMS_ALIYUN_* / CMS_TENCENT_*)
//   POST /server/account/delete  — Permanently delete the authenticated user's account (Bearer user JWT)
//
// Environment variables (set in Supabase Dashboard > Edge Functions > Secrets):
//   SUPABASE_URL              — Auto-injected by Supabase
//   SUPABASE_ANON_KEY         — Auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — Auto-injected by Supabase
//
// WeChat / Alipay / LINE (POST /wechat/exchange, POST /alipay/exchange, POST /line/exchange):
//   WECHAT_APP_ID, WECHAT_APP_SECRET — 微信开放平台 / 公众号网页授权 snsapi 换 access_token
//   ALIPAY_APP_ID, ALIPAY_APP_PRIVATE_KEY_PEM — 支付宝开放平台 RSA2（PKCS#8 PEM，可含 \n 转义）
//   ALIPAY_GATEWAY_URL — 可选，默认 https://openapi.alipay.com/gateway.do（沙箱用 openapi.alipaydev.com）
//   LINE_CHANNEL_ID, LINE_CHANNEL_SECRET — LINE Login channel（LINE Developers Console 创建）
//
// Config writes (POST /config, GET /config/history, POST /config/rollback):
//   Production farmer PWA does not call these (pull-only). Operators may use:
//   POST /config — (1) Bearer JWT + content_role IN ('admin','editor') or (2) X-Config-Write-Secret
//   GET /config/history, POST /config/rollback — content admin JWT or X-Config-Write-Secret only (editors excluded)
//   CONFIG_WRITE_SECRET       — Callers must send header X-Config-Write-Secret: <same>
//   ALLOW_INSECURE_PUBLIC_CONFIG_WRITE — "true" = anon-only writes (legacy / dev only)
//
// Profile (GET/POST /profile):
//   Requires Authorization: Bearer <user access_token> (not the anon key).
//   apikey header should still be the anon key (Supabase Edge convention).
//   POST /profile rate limit (anti-abuse): Secrets 中可选 PROFILE_POST_MIN_INTERVAL_SECONDS（默认 300，0=关闭）。
//   仅当该行 profile_completed 已为 true 时按 user_profiles.last_profile_post_at 间隔拒绝（429 + Retry-After）。
//
// Required tables (see /supabase/migrations/001_init.sql):
//   app_config      — Remote configuration (RLS: service_role only)
//   config_history  — Version snapshots for rollback (RLS: service_role only)
//   user_profiles   — User profile storage (RLS: service_role only)
//   regional_oauth_identities — WeChat openid / Alipay user_id / LINE userId ↔ auth.users (RLS: service_role only)
//   push_subscriptions — Web Push / FCM / JPush device registration (RLS: service_role only; writes via POST /push/*)
//
// Push notification secrets (set in Supabase Dashboard > Edge Functions > Secrets):
//   Web Push: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
//   FCM:      FCM_SERVICE_ACCOUNT_JSON
//   JPush:    JPUSH_APP_KEY, JPUSH_MASTER_SECRET, JPUSH_APNS_PRODUCTION (optional)
// ============================================================================

import { createClient, type User } from "jsr:@supabase/supabase-js@2.49.8";
import { mergeConfigPreserveEmptyMediaUrls } from "../_shared/configMergeEmptyPreserve.ts";
import { cmsS3Presign } from "../_shared/cmsPresignLogic.ts";
import {
  sendFcmV1,
  sendJpush,
  configureWebPushOnce,
  webpush,
  pickStrings,
} from "../_shared/push.ts";

// ---- Supabase clients ----

/** Admin client (service_role) — bypasses RLS, used for all DB operations */
function getAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/** Auth client (anon key + user JWT) — used for Supabase Auth operations */
function getAuthClient(authHeader?: string) {
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    authHeader
      ? { global: { headers: { Authorization: authHeader } } }
      : undefined,
  );
  return client;
}

// ---- CORS helpers ----

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info, x-config-write-secret",
};

function json(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** POST /profile 最小间隔（秒）。Secret PROFILE_POST_MIN_INTERVAL_SECONDS：未设置默认 300；设为 0 关闭。 */
function getProfilePostMinIntervalSeconds(): number {
  const raw = (Deno.env.get("PROFILE_POST_MIN_INTERVAL_SECONDS") ?? "").trim();
  if (raw === "0") return 0;
  const n = parseInt(raw || "300", 10);
  if (!Number.isFinite(n) || n < 0) return 300;
  return Math.min(n, 86400);
}

// ---- Route extraction ----
// Edge Function is mounted at /server, so:
//   Full URL: https://xxx.supabase.co/functions/v1/server/config
//   req.url pathname: /server/config
//   We strip the /server prefix to get /config

function getRoute(req: Request): string {
  const url = new URL(req.url);
  // pathname = /server/config → strip /server → /config
  const path = url.pathname.replace(/^\/server/, "") || "/";
  return path;
}

/** Constant-time string compare for secrets */
function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) diff |= aBuf[i]! ^ bBuf[i]!;
  return diff === 0;
}

/**
 * Returns the caller's content role ('admin' | 'editor') if the JWT user has write access.
 * Returns null if access is granted via secret/insecure flag (no role restriction).
 * Returns an error Response if access is denied.
 * Order: insecure flag → write secret header → JWT + content_role.
 */
async function assertConfigWriteAllowed(req: Request): Promise<Response | null | string> {
  if (Deno.env.get("ALLOW_INSECURE_PUBLIC_CONFIG_WRITE") === "true") {
    console.warn(
      "[server] SECURITY: ALLOW_INSECURE_PUBLIC_CONFIG_WRITE=true — config writes accept anon-only callers. NEVER enable on public production.",
    );
    return null;
  }

  const secret = (Deno.env.get("CONFIG_WRITE_SECRET") || "").trim();
  const presented = (req.headers.get("X-Config-Write-Secret") || "").trim();
  if (secret.length >= 16 && timingSafeEqualString(presented, secret)) {
    return null;
  }

  const authHeader = req.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (token && token !== anon) {
    const client = getAuthClient();
    const { data: { user }, error } = await client.auth.getUser(token);
    if (!error && user) {
      const admin = getAdminClient();
      const { data: row, error: rowErr } = await admin
        .from("user_profiles")
        .select("content_role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (rowErr) {
        console.error("[config/write-auth] profile read:", rowErr);
        return err("Database error checking content role", 500);
      }
      const role = (row?.content_role as string) || "none";
      if (role === "admin" || role === "editor") {
        return role;
      }
      return err("Forbidden: content admin/editor only", 403);
    }
  }

  if (secret.length < 16) {
    return err(
      "Config writes disabled: log in as content admin/editor, set CONFIG_WRITE_SECRET (≥16 chars), " +
        "or set ALLOW_INSECURE_PUBLIC_CONFIG_WRITE=true for legacy mode (not recommended).",
      403,
    );
  }
  return err("Unauthorized: missing or invalid X-Config-Write-Secret or session", 401);
}

/**
 * Config history / rollback: content admin JWT or CONFIG_WRITE_SECRET only (editors excluded).
 * Does not honor ALLOW_INSECURE_PUBLIC_CONFIG_WRITE.
 */
async function assertConfigAdminOnly(req: Request): Promise<Response | null> {
  const secret = (Deno.env.get("CONFIG_WRITE_SECRET") || "").trim();
  const presented = (req.headers.get("X-Config-Write-Secret") || "").trim();
  if (secret.length >= 16 && timingSafeEqualString(presented, secret)) {
    return null;
  }

  const auth = await requireUserJwt(req);
  if (auth instanceof Response) {
    if (secret.length < 16) {
      return err(
        "Config admin access required: log in as content admin or set CONFIG_WRITE_SECRET (≥16 chars)",
        403,
      );
    }
    return auth;
  }

  const admin = getAdminClient();
  const { data: row, error } = await admin
    .from("user_profiles")
    .select("content_role")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) {
    console.error("[config/admin-auth] profile read:", error);
    return err("Database error checking content role", 500);
  }
  const role = (row?.content_role as string) || "none";
  if (role !== "admin") {
    return err("Forbidden: content admin only", 403);
  }
  return null;
}

/** Only `content_role === 'admin'` may assign roles to other users (super-admin). */
async function assertContentAdminOnly(
  req: Request,
): Promise<{ user: User } | Response> {
  const auth = await requireUserJwt(req);
  if (auth instanceof Response) return auth;
  const admin = getAdminClient();
  const { data: row, error } = await admin
    .from("user_profiles")
    .select("content_role")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) {
    console.error("[admin-role] profile read", error);
    return err("Database error", 500);
  }
  const role = (row?.content_role as string) || "none";
  if (role !== "admin") {
    return err("Forbidden: content admin only", 403);
  }
  return auth;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseContentRoleForAssign(raw: unknown): "none" | "editor" | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "none" || s === "clear" || s === "revoke") return "none";
  if (s === "editor") return "editor";
  return null;
}

function parseAppRoleForAssign(raw: unknown): "farmer" | "distributor" | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "farmer" || s === "农户" || s === "農戶") return "farmer";
  if (s === "distributor" || s === "门店" || s === "分销商") return "distributor";
  return null;
}

/** GET /admin/distributors — list users with app_role = distributor (admin JWT only). */
async function handleGetAdminDistributors(_req: Request): Promise<Response> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("user_profiles")
    .select("user_id, display_name, phone, content_role, app_role, updated_at")
    .eq("app_role", "distributor")
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (error) {
    console.error("[admin/distributors] query", error);
    return err(`Database error: ${error.message}`, 500);
  }
  return json({ ok: true, rows: data ?? [] });
}

/** POST /admin/user-roles — batch set content_role (none|editor) and/or app_role (farmer|distributor). Admin JWT only. */
async function handlePostAdminUserRoles(
  req: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON", 400);
  }
  const rowsRaw = body?.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    return err("Expected non-empty rows array", 400);
  }
  if (rowsRaw.length > 200) {
    return err("Too many rows (max 200 per request)", 400);
  }

  const admin = getAdminClient();
  const results: Array<{ userId: string; ok: boolean; error?: string }> = [];

  for (const entry of rowsRaw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      results.push({ userId: "", ok: false, error: "Invalid row" });
      continue;
    }
    const r = entry as Record<string, unknown>;
    const userId = typeof r.userId === "string" ? r.userId.trim() : "";
    if (!UUID_RE.test(userId)) {
      results.push({ userId: userId || "(invalid)", ok: false, error: "Invalid user_id UUID" });
      continue;
    }

    const cr = parseContentRoleForAssign(r.contentRole ?? r.content_role);
    const ar = parseAppRoleForAssign(r.appRole ?? r.app_role);
    if (cr === null && ar === null) {
      results.push({ userId, ok: false, error: "No contentRole or appRole to apply" });
      continue;
    }

    const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(
      userId,
    );
    if (authErr || !authUser?.user) {
      results.push({ userId, ok: false, error: "User not found in auth" });
      continue;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (cr !== null) patch.content_role = cr;
    if (ar !== null) patch.app_role = ar;

    const { data: existing, error: exErr } = await admin
      .from("user_profiles")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (exErr) {
      console.error("[admin/user-roles] select", exErr);
      results.push({ userId, ok: false, error: exErr.message });
      continue;
    }

    if (existing) {
      const { error: upErr } = await admin.from("user_profiles").update(patch).eq(
        "user_id",
        userId,
      );
      if (upErr) {
        results.push({ userId, ok: false, error: upErr.message });
      } else {
        results.push({ userId, ok: true });
      }
    } else {
      const ins = {
        user_id: userId,
        profile: {},
        display_name: "",
        phone: "",
        pickup_address: "",
        avatar_url: "",
        profile_completed: false,
        content_role: (cr ?? "none") as string,
        app_role: (ar ?? "farmer") as string,
        updated_at: patch.updated_at,
      };
      const { error: insErr } = await admin.from("user_profiles").insert(ins);
      if (insErr) {
        results.push({ userId, ok: false, error: insErr.message });
      } else {
        results.push({ userId, ok: true });
      }
    }
  }

  return json({ ok: true, results });
}

async function requireUserJwt(
  req: Request,
): Promise<{ user: User } | Response> {
  const authHeader = req.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!token || token === anon) {
    return err(
      "User session required: use Authorization Bearer <access_token> from login (not anon key)",
      401,
    );
  }
  const client = getAuthClient();
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) {
    return err("Invalid or expired session", 401);
  }
  return { user };
}

// ---- Main handler ----

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const route = getRoute(req);
  const method = req.method;

  try {
    // =============================================
    // GET /health — Health check
    // =============================================
    if (route === "/health" && method === "GET") {
      return json({
        status: "ok",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
      });
    }

    // =============================================
    // GET /config — Read remote app_config
    // =============================================
    if (route === "/config" && method === "GET") {
      return await handleGetConfig(req);
    }

    // =============================================
    // POST /config — Write remote app_config
    // =============================================
    if (route === "/config" && method === "POST") {
      const authOrDenied = await assertConfigWriteAllowed(req);
      if (authOrDenied instanceof Response) return authOrDenied;
      const callerRole = authOrDenied || "admin";
      const body = await req.json();
      return await handlePostConfig(body, callerRole);
    }

    // =============================================
    // GET /config/history — List config version history
    // =============================================
    if (route === "/config/history" && method === "GET") {
      const denied = await assertConfigAdminOnly(req);
      if (denied) return denied;
      const url = new URL(req.url);
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      return await handleConfigHistory(limit);
    }

    // =============================================
    // POST /config/rollback — Rollback to a previous version
    // =============================================
    if (route === "/config/rollback" && method === "POST") {
      const denied = await assertConfigAdminOnly(req);
      if (denied) return denied;
      const body = await req.json();
      return await handleConfigRollback(body);
    }

    // =============================================
    // POST /send-code — Send OTP verification code
    // =============================================
    if (route === "/send-code" && method === "POST") {
      const body = await req.json();
      return await handleSendCode(body);
    }

    // =============================================
    // POST /auth — Verify OTP code + return userId
    // =============================================
    if (route === "/auth" && method === "POST") {
      const body = await req.json();
      return await handleAuth(body);
    }

    // =============================================
    // POST /oauth-exchange — Exchange OAuth code for token
    // =============================================
    if (route === "/oauth-exchange" && method === "POST") {
      const body = await req.json();
      return await handleOAuthExchange(body);
    }

    // =============================================
    // POST /wechat/exchange — WeChat code → session
    // =============================================
    if (route === "/wechat/exchange" && method === "POST") {
      const body = await req.json();
      return await handleWechatExchange(body);
    }

    // =============================================
    // POST /alipay/exchange — Alipay auth_code → session
    // =============================================
    if (route === "/alipay/exchange" && method === "POST") {
      const body = await req.json();
      return await handleAlipayExchange(body);
    }

    // =============================================
    // POST /line/exchange — LINE code → session
    // =============================================
    if (route === "/line/exchange" && method === "POST") {
      const body = await req.json();
      return await handleLineExchange(body);
    }

    // =============================================
    // GET /profile — Get user profile
    // =============================================
    if (route === "/profile" && method === "GET") {
      const auth = await requireUserJwt(req);
      if (auth instanceof Response) return auth;
      return await handleGetProfile(auth.user);
    }

    // =============================================
    // POST /profile — Save user profile
    // =============================================
    if (route === "/profile" && method === "POST") {
      const auth = await requireUserJwt(req);
      if (auth instanceof Response) return auth;
      const body = await req.json();
      return await handlePostProfile(body, auth.user.id);
    }

    // =============================================
    // POST /push/subscribe — Register Web Push or FCM token
    // =============================================
    if (route === "/push/subscribe" && method === "POST") {
      const auth = await requireUserJwt(req);
      if (auth instanceof Response) return auth;
      const body = await req.json();
      return await handlePushSubscribe(body, auth.user.id);
    }

    // =============================================
    // POST /push/unsubscribe — Remove push registration
    // =============================================
    if (route === "/push/unsubscribe" && method === "POST") {
      const auth = await requireUserJwt(req);
      if (auth instanceof Response) return auth;
      const body = await req.json();
      return await handlePushUnsubscribe(body, auth.user.id);
    }

    // =============================================
    // POST /push/send — Broadcast push to all subscribers (admin/editor only)
    // =============================================
    if (route === "/push/send" && method === "POST") {
      const role = await assertConfigWriteAllowed(req);
      if (role instanceof Response) return role;
      const body = await req.json();
      return await handlePushSend(body);
    }

    // =============================================
    // GET /admin/distributors — Distributor list (content admin JWT only)
    // =============================================
    if (route === "/admin/distributors" && method === "GET") {
      const auth = await assertContentAdminOnly(req);
      if (auth instanceof Response) return auth;
      return await handleGetAdminDistributors(req);
    }

    // =============================================
    // POST /admin/user-roles — Batch role assignment (content admin JWT only)
    // =============================================
    if (route === "/admin/user-roles" && method === "POST") {
      const auth = await assertContentAdminOnly(req);
      if (auth instanceof Response) return auth;
      return await handlePostAdminUserRoles(req);
    }

    // =============================================
    // POST /cms/presign — Presigned PUT for Cloudflare R2 / OSS / COS (CMS only)
    // =============================================
    if (route === "/cms/presign" && method === "POST") {
      return await handleCmsPresign(req);
    }

    // =============================================
    // POST /account/delete — Permanently delete authenticated user account
    // =============================================
    if (route === "/account/delete" && method === "POST") {
      const auth = await requireUserJwt(req);
      if (auth instanceof Response) return auth;
      return await handleAccountDelete(auth.user.id);
    }

    // =============================================
    // 404 — Unknown route
    // =============================================
    return err(`Unknown route: ${method} ${route}`, 404);
  } catch (e: any) {
    console.error("[EdgeFunction] Unhandled error:", e);
    return err(e.message || "Internal server error", 500);
  }
});

// ============================================================================
// Config handlers
// ============================================================================

async function handleCmsPresign(req: Request): Promise<Response> {
  const auth = await requireUserJwt(req);
  if (auth instanceof Response) return auth;

  const admin = getAdminClient();
  const { data: row, error: perr } = await admin
    .from("user_profiles")
    .select("content_role")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (perr) {
    console.error("[cms/presign] profile read", perr);
    return err("Database error", 500);
  }
  const role = (row?.content_role as string) || "none";
  if (role !== "admin" && role !== "editor") {
    return err("Forbidden: content admin/editor only", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON", 400);
  }

  const result = await cmsS3Presign(
    {
      provider: String(body.provider ?? ""),
      fileName: String(body.fileName ?? ""),
      contentType: String(body.contentType ?? ""),
      byteSize: Number(body.byteSize),
    },
    auth.user.id,
  );

  if (!result.ok) return err(result.error, result.status);
  return json(result.data);
}

/** Returns the content_role string ('none' | 'editor' | 'admin') when a valid user JWT is present, or 'none' otherwise. */
async function getJwtUserContentRole(req: Request): Promise<string> {
  const authHeader = req.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!token || token === anon) return "none";
  const client = getAuthClient();
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) return "none";
  const admin = getAdminClient();
  const { data: row, error: rowErr } = await admin
    .from("user_profiles")
    .select("content_role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (rowErr) return "none";
  return (row?.content_role as string) || "none";
}

/** Strip operator-only fields for anonymous / non-admin clients. */
function redactPublicConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const c = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const cloud = c.cloudAIConfig;
  if (cloud && typeof cloud === "object" && !Array.isArray(cloud)) {
    delete (cloud as Record<string, unknown>).systemPrompt;
  }
  return c;
}

async function handleGetConfig(req: Request): Promise<Response> {
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("app_config")
    .select("config, version, updated_at, updated_by")
    .eq("id", "main")
    .maybeSingle();

  if (error) {
    console.error("[config/GET] DB error:", error);
    return err(`Database error: ${error.message}`, 500);
  }

  if (!data) {
    // No row exists — first run, return null signal
    return json({ data: null });
  }

  const role = await getJwtUserContentRole(req);
  const configOut = (role === "admin" || role === "editor") ? data.config : redactPublicConfig(data.config);

  return json({
    config: configOut,
    version: data.version,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by,
  });
}

async function handlePostConfig(body: any, callerRole?: string): Promise<Response> {
  const { config, expectedVersion, note, updatedBy } = body;

  if (!config || typeof config !== "object") {
    return err("Missing or invalid 'config' field");
  }

  // Editor-allowed fields (Content, Market, Appearance, Legal)
  const EDITOR_FIELDS = new Set([
    "banners", "liveStreams", "articles", "marketPage",
    "filing", "aboutUs", "privacyPolicy", "termsOfService", "technicalSupport",
    "appBranding", "splashScreen", "homeIcons", "desktopIcon",
  ]);

  const admin = getAdminClient();

  // --- Step 1: Read current version + config for optimistic lock + empty-URL merge ---
  const { data: current, error: readErr } = await admin
    .from("app_config")
    .select("version, config")
    .eq("id", "main")
    .maybeSingle();

  if (readErr) {
    console.error("[config/POST] Read error:", readErr);
    return err(`Database error: ${readErr.message}`, 500);
  }

  const currentVersion = current?.version ?? 0;

  // --- Step 2: Optimistic lock check ---
  if (expectedVersion !== null && expectedVersion !== undefined) {
    if (currentVersion !== expectedVersion) {
      return json(
        {
          success: false,
          conflict: true,
          currentVersion,
          message: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}`,
        },
        409,
      );
    }
  }

  // --- Step 2.5: Editor field scoping ---
  let scopedConfig = config;
  if (callerRole === "editor") {
    const prev = (current?.config as Record<string, unknown>) ?? {};
    scopedConfig = { ...prev };
    for (const key of EDITOR_FIELDS) {
      if (key in config) {
        (scopedConfig as Record<string, unknown>)[key] = config[key];
      }
    }
  }

  const prevCfg = current?.config;
  const mergedConfig =
    prevCfg !== undefined && prevCfg !== null && typeof prevCfg === "object"
      ? mergeConfigPreserveEmptyMediaUrls(scopedConfig, prevCfg)
      : scopedConfig;

  // --- Step 3: Write config ---
  // Do NOT set `version` explicitly — the database trigger
  // (trg_app_config_auto_version) automatically increments it
  // when `config` changes. This avoids double-increment issues.
  if (current) {
    // Row exists → UPDATE (triggers fire on UPDATE)
    const { error: writeErr } = await admin
      .from("app_config")
      .update({
        config: mergedConfig,
        updated_by: updatedBy || null,
      })
      .eq("id", "main");

    if (writeErr) {
      console.error("[config/POST] Write error:", writeErr);
      return err(`Database error: ${writeErr.message}`, 500);
    }
  } else {
    // No row yet → INSERT with version 1 (no trigger on insert)
    const { error: writeErr } = await admin.from("app_config").insert({
      id: "main",
      config: mergedConfig,
      version: 1,
      updated_by: updatedBy || null,
    });

    if (writeErr) {
      console.error("[config/POST] Insert error:", writeErr);
      return err(`Database error: ${writeErr.message}`, 500);
    }
  }

  // --- Step 4: Read back actual version (set by trigger) ---
  const { data: updated } = await admin
    .from("app_config")
    .select("version, updated_at")
    .eq("id", "main")
    .single();

  // Note: config_history snapshot is created automatically by the
  // database trigger (trg_app_config_auto_history) on every UPDATE.
  // No manual INSERT into config_history is needed here.

  return json({
    success: true,
    newVersion: updated?.version ?? currentVersion + 1,
    updatedAt: updated?.updated_at ?? new Date().toISOString(),
  });
}

async function handleConfigHistory(limit: number): Promise<Response> {
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("config_history")
    .select("id, version, created_at, created_by, note")
    .order("version", { ascending: false })
    .limit(Math.min(limit, 100));

  if (error) {
    console.error("[config/history] DB error:", error);
    return err(`Database error: ${error.message}`, 500);
  }

  return json({ history: data || [] });
}

async function handleConfigRollback(body: any): Promise<Response> {
  const { version, rollbackBy } = body;

  if (typeof version !== "number") {
    return err("Missing or invalid 'version' field");
  }

  const admin = getAdminClient();

  // --- Step 1: Find the target version in config_history ---
  const { data: snapshot, error: findErr } = await admin
    .from("config_history")
    .select("config, version")
    .eq("version", version)
    .maybeSingle();

  if (findErr) {
    return err(`Database error: ${findErr.message}`, 500);
  }

  if (!snapshot) {
    return err(`Version ${version} not found in history`, 404);
  }

  // --- Step 2: Write the rolled-back config ---
  // Use UPDATE so the trigger auto-increments version and saves history.
  const { error: writeErr } = await admin
    .from("app_config")
    .update({
      config: snapshot.config,
      updated_by: rollbackBy || `rollback-to-v${version}`,
    })
    .eq("id", "main");

  if (writeErr) {
    return err(`Database error: ${writeErr.message}`, 500);
  }

  // Read back the new version (set by trigger)
  const { data: updated } = await admin
    .from("app_config")
    .select("version")
    .eq("id", "main")
    .single();

  return json({
    success: true,
    newVersion: updated?.version ?? 0,
    rolledBackTo: version,
  });
}

// ============================================================================
// Auth handlers
// ============================================================================

async function handleSendCode(body: any): Promise<Response> {
  const { method, credential } = body;

  if (!method || !credential) {
    return err("Missing 'method' or 'credential'");
  }

  if (method !== "phone" && method !== "email") {
    return err("method must be 'phone' or 'email'");
  }

  const authClient = getAuthClient();

  if (method === "phone") {
    const { error } = await authClient.auth.signInWithOtp({
      phone: credential,
    });
    if (error) {
      console.error("[send-code] Phone OTP error:", error);
      return err(error.message, 400);
    }
  } else {
    const { error } = await authClient.auth.signInWithOtp({
      email: credential,
    });
    if (error) {
      console.error("[send-code] Email OTP error:", error);
      return err(error.message, 400);
    }
  }

  return json({ success: true });
}

async function handleAuth(body: any): Promise<Response> {
  const { method, credential, code } = body;

  if (!method || !credential || !code) {
    return err("Missing 'method', 'credential', or 'code'");
  }

  const authClient = getAuthClient();

  let result;
  if (method === "phone") {
    result = await authClient.auth.verifyOtp({
      phone: credential,
      token: code,
      type: "sms",
    });
  } else {
    result = await authClient.auth.verifyOtp({
      email: credential,
      token: code,
      type: "email",
    });
  }

  if (result.error) {
    console.error("[auth] Verify OTP error:", result.error);
    return err(result.error.message, 401);
  }

  const session = result.data.session;
  const user = result.data.user;

  if (!user) {
    return err("Verification succeeded but no user returned", 500);
  }

  const admin = getAdminClient();
  await upsertUserProfileAfterOtpOrMerge(admin, user.id, {
    email: user.email ?? null,
    phoneAuth: user.phone ?? null,
  });

  return json({
    userId: user.id,
    accessToken: session?.access_token || null,
    refreshToken: session?.refresh_token || null,
    expiresIn: session?.expires_in || null,
  });
}

async function handleOAuthExchange(body: any): Promise<Response> {
  const { provider, code, redirectUri } = body;

  if (!provider || !code) {
    return err("Missing 'provider' or 'code'");
  }

  const authClient = getAuthClient();

  // Exchange the OAuth authorization code for a session
  const { data, error } = await authClient.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[oauth-exchange] Error:", error);
    return err(error.message, 401);
  }

  const session = data.session;
  const user = data.user;

  if (!user) {
    return err("OAuth exchange succeeded but no user returned", 500);
  }

  const admin = getAdminClient();
  const meta = (user.user_metadata || {}) as Record<string, unknown>;
  const dn =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    "";
  const av =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    "";
  await upsertUserProfileAfterOauthExchange(admin, user.id, {
    email: user.email ?? null,
    provider,
    displayNameHint: typeof dn === "string" ? dn : "",
    avatarUrlHint: typeof av === "string" ? av : "",
  });

  return json({
    userId: user.id,
    accessToken: session?.access_token || null,
    refreshToken: session?.refresh_token || null,
    expiresIn: session?.expires_in || null,
  });
}

type RegionalProvider = "wechat" | "alipay" | "line";

function randomLoginEmail(): string {
  const id = crypto.randomUUID();
  return `regional_${id}@regional.oauth.invalid`;
}

const DISPLAY_NAME_MAX = 120;
const AVATAR_URL_MAX_CHARS = 450_000;
const PICKUP_ADDRESS_MAX_CHARS = 200;

/** OAuth / social avatar URLs (e.g. Google `picture`); not persisted in `user_profiles`. */
function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function oauthAvatarFromUserMetadata(user: User): string {
  const m = (user.user_metadata || {}) as Record<string, unknown>;
  let av =
    (typeof m.avatar_url === "string" && isHttpUrl(m.avatar_url) ? m.avatar_url : "") ||
    (typeof m.picture === "string" && isHttpUrl(m.picture) ? m.picture : "") ||
    (typeof m.profile_image_url_https === "string" && isHttpUrl(m.profile_image_url_https)
      ? m.profile_image_url_https
      : "") ||
    "";
  const p = m.picture;
  if (!av && p && typeof p === "object" && p !== null && "data" in p) {
    const u = (p as { data?: { url?: string } }).data?.url;
    if (typeof u === "string" && isHttpUrl(u)) av = u;
  }
  return av.slice(0, AVATAR_URL_MAX_CHARS);
}

function sanitizePhoneColumn(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/[^\d+\s\-().]/g, "").slice(0, 32);
}

function clipPickupAddress(raw: string): string {
  return [...raw.trim()].slice(0, PICKUP_ADDRESS_MAX_CHARS).join("");
}

function computeProfileCompleted(
  display_name: string,
  phone: string,
  pickup_address: string,
): boolean {
  return [display_name, phone, pickup_address].every((s) =>
    String(s).trim().length > 0
  );
}

/** Remove keys stored in dedicated columns from JSON extras. */
function stripColumnKeysFromProfileJson(
  p: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...p };
  delete out.name;
  delete out.avatar;
  delete out.phone;
  delete out.pickup_address;
  delete out.pickupAddress;
  return out;
}

async function upsertProfileAfterRegionalLogin(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  profilePatch: Record<string, unknown>,
): Promise<void> {
  const { data: row, error: re } = await admin
    .from("user_profiles")
    .select(
      "profile, display_name, avatar_url, phone, pickup_address",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (re) {
    console.error("[regional] read user_profiles:", re);
  }

  const prev =
    row?.profile && typeof row.profile === "object" && !Array.isArray(row.profile)
      ? (row.profile as Record<string, unknown>)
      : {};

  const mergedExtras = stripColumnKeysFromProfileJson({
    ...prev,
    ...profilePatch,
  });

  let display_name = typeof row?.display_name === "string" ? row.display_name : "";
  if (typeof profilePatch.name === "string" && profilePatch.name.trim()) {
    display_name = profilePatch.name.trim().slice(0, DISPLAY_NAME_MAX);
  }

  const avatar_url = "";

  let phone = typeof row?.phone === "string" ? row.phone : "";
  if ("phone" in profilePatch) {
    phone = sanitizePhoneColumn(profilePatch.phone);
  }

  let pickup_address = typeof row?.pickup_address === "string"
    ? row.pickup_address
    : "";
  if (typeof profilePatch.pickup_address === "string") {
    pickup_address = clipPickupAddress(profilePatch.pickup_address);
  } else if (typeof profilePatch.pickupAddress === "string") {
    pickup_address = clipPickupAddress(profilePatch.pickupAddress);
  }

  const profile_completed = computeProfileCompleted(
    display_name,
    phone,
    pickup_address,
  );

  const { error } = await admin.from("user_profiles").upsert(
    {
      user_id: userId,
      profile: mergedExtras,
      display_name,
      avatar_url,
      phone,
      pickup_address,
      profile_completed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("[regional] upsert user_profiles:", error);
}

/** OTP / phone auth: merge extras, set phone column, preserve display columns. */
async function upsertUserProfileAfterOtpOrMerge(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  patch: { email?: string | null; phoneAuth?: string | null },
): Promise<void> {
  const { data: row, error: re } = await admin
    .from("user_profiles")
    .select(
      "profile, display_name, avatar_url, phone, pickup_address",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (re) console.error("[auth/otp] read user_profiles:", re);

  const prev =
    row?.profile && typeof row.profile === "object" && !Array.isArray(row.profile)
      ? (row.profile as Record<string, unknown>)
      : {};
  const extras = stripColumnKeysFromProfileJson({
    ...prev,
    email: patch.email ?? prev.email,
  });

  const phone = sanitizePhoneColumn(
    patch.phoneAuth != null && String(patch.phoneAuth).trim()
      ? patch.phoneAuth
      : row?.phone ?? "",
  );

  const display_name = typeof row?.display_name === "string" ? row.display_name : "";
  const avatar_url = "";
  const pickup_address = typeof row?.pickup_address === "string"
    ? row.pickup_address
    : "";

  const profile_completed = computeProfileCompleted(
    display_name,
    phone,
    pickup_address,
  );

  const { error } = await admin.from("user_profiles").upsert(
    {
      user_id: userId,
      profile: extras,
      display_name,
      avatar_url,
      phone,
      pickup_address,
      profile_completed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("[auth/otp] upsert user_profiles:", error);
}

/** OAuth code exchange: seed display/avatar from provider metadata when empty. */
async function upsertUserProfileAfterOauthExchange(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  patch: {
    email?: string | null;
    provider: string;
    displayNameHint: string;
    avatarUrlHint: string;
  },
): Promise<void> {
  const { data: row, error: re } = await admin
    .from("user_profiles")
    .select(
      "profile, display_name, avatar_url, phone, pickup_address",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (re) console.error("[oauth-exchange] read user_profiles:", re);

  const prev =
    row?.profile && typeof row.profile === "object" && !Array.isArray(row.profile)
      ? (row.profile as Record<string, unknown>)
      : {};
  const extras = stripColumnKeysFromProfileJson({
    ...prev,
    email: patch.email ?? prev.email,
    provider: patch.provider,
  });

  let display_name = typeof row?.display_name === "string" ? row.display_name : "";
  if (patch.displayNameHint.trim()) {
    display_name = patch.displayNameHint.trim().slice(0, DISPLAY_NAME_MAX);
  }

  const avatar_url = "";

  const phone = typeof row?.phone === "string" ? row.phone : "";
  const pickup_address = typeof row?.pickup_address === "string"
    ? row.pickup_address
    : "";

  const profile_completed = computeProfileCompleted(
    display_name,
    phone,
    pickup_address,
  );

  const { error } = await admin.from("user_profiles").upsert(
    {
      user_id: userId,
      profile: extras,
      display_name,
      avatar_url,
      phone,
      pickup_address,
      profile_completed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("[oauth-exchange] upsert user_profiles:", error);
}

/** Optional nickname/avatar for client-only local profile (not persisted beyond existing user_profiles upsert). */
type OauthClientProfileHint = { name?: string | null; avatar?: string | null };

/** 合并微信/支付宝昵称与头像到 Auth user_metadata，供 GET /profile 从 JWT 读取（不落库 user_profiles.avatar_url）。 */
function mergeRegionalHintIntoUserMetadata(
  prev: Record<string, unknown> | null | undefined,
  hint: OauthClientProfileHint | null | undefined,
): Record<string, unknown> {
  const m = { ...(prev && typeof prev === "object" ? prev : {}) } as Record<
    string,
    unknown
  >;
  if (hint?.name != null && String(hint.name).trim()) {
    m.full_name = String(hint.name).trim();
  }
  if (hint?.avatar != null && String(hint.avatar).trim()) {
    const u = String(hint.avatar).trim();
    m.avatar_url = u;
    m.picture = u;
  }
  return m;
}

/** Issue Supabase session via one-shot password rotation + anon signIn (secrets never leave Edge). */
async function finalizeRegionalSession(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  loginEmail: string,
  profilePatch: Record<string, unknown>,
  oauthClientProfile?: OauthClientProfileHint | null,
): Promise<Response> {
  const password = crypto.randomUUID() + crypto.randomUUID();
  const { data: existingUser, error: gerr } = await admin.auth.admin.getUserById(
    userId,
  );
  if (gerr || !existingUser?.user) {
    console.error("[regional] getUserById:", gerr);
    return err(gerr?.message || "Failed to read user", 500);
  }
  const prevMeta = (existingUser.user.user_metadata || {}) as Record<
    string,
    unknown
  >;
  const user_metadata = mergeRegionalHintIntoUserMetadata(
    prevMeta,
    oauthClientProfile ?? null,
  );
  const { error: uerr } = await admin.auth.admin.updateUserById(userId, {
    password,
    email_confirm: true,
    user_metadata,
  });
  if (uerr) {
    console.error("[regional] updateUserById:", uerr);
    return err(uerr.message || "Failed to issue session", 500);
  }
  const anon = getAuthClient();
  const { data: sdata, error: serr } = await anon.auth.signInWithPassword({
    email: loginEmail,
    password,
  });
  if (serr || !sdata.session || !sdata.user) {
    console.error("[regional] signInWithPassword:", serr);
    return err(serr?.message || "Failed to sign in after regional exchange", 500);
  }
  const session = sdata.session;
  const user = sdata.user;
  await upsertProfileAfterRegionalLogin(admin, user.id, profilePatch);
  const body: Record<string, unknown> = {
    userId: user.id,
    accessToken: session.access_token ?? null,
    refreshToken: session.refresh_token ?? null,
    expiresIn: session.expires_in ?? null,
  };
  if (
    oauthClientProfile &&
    (oauthClientProfile.name != null || oauthClientProfile.avatar != null)
  ) {
    body.oauthProfile = {
      name: oauthClientProfile.name ?? null,
      avatar: oauthClientProfile.avatar ?? null,
    };
  }
  return json(body);
}

async function findRegionalIdentity(
  admin: ReturnType<typeof getAdminClient>,
  provider: RegionalProvider,
  subject: string,
): Promise<{ user_id: string; login_email: string } | null> {
  const { data, error } = await admin
    .from("regional_oauth_identities")
    .select("user_id, login_email")
    .eq("provider", provider)
    .eq("subject", subject)
    .maybeSingle();
  if (error) {
    console.error("[regional] find identity:", error);
    return null;
  }
  if (!data?.user_id || !data?.login_email) return null;
  return { user_id: data.user_id, login_email: data.login_email };
}

async function createRegionalUserAndSession(
  admin: ReturnType<typeof getAdminClient>,
  provider: RegionalProvider,
  subject: string,
  profilePatch: Record<string, unknown>,
  oauthClientProfile?: OauthClientProfileHint | null,
): Promise<Response> {
  const loginEmail = randomLoginEmail();
  const password = crypto.randomUUID() + crypto.randomUUID();
  const user_metadata = mergeRegionalHintIntoUserMetadata(
    {
      regional_provider: provider,
      regional_subject: subject,
    },
    oauthClientProfile ?? null,
  );
  const { data: created, error: cerr } = await admin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
    user_metadata,
  });
  if (cerr || !created.user) {
    console.error("[regional] createUser:", cerr);
    return err(cerr?.message || "Failed to create auth user", 500);
  }
  const uid = created.user.id;
  const { error: ierr } = await admin.from("regional_oauth_identities").insert({
    user_id: uid,
    provider,
    subject,
    login_email: loginEmail,
  });
  if (ierr) {
    console.error("[regional] insert identity:", ierr);
    await admin.auth.admin.deleteUser(uid);
    if (ierr.code === "23505") {
      const row = await findRegionalIdentity(admin, provider, subject);
      if (row) {
        return finalizeRegionalSession(
          admin,
          row.user_id,
          row.login_email,
          profilePatch,
          oauthClientProfile,
        );
      }
    }
    return err(ierr.message || "Failed to save regional identity", 500);
  }
  const anon = getAuthClient();
  const { data: sdata, error: serr } = await anon.auth.signInWithPassword({
    email: loginEmail,
    password,
  });
  if (serr || !sdata.session || !sdata.user) {
    console.error("[regional] first signIn:", serr);
    return err(serr?.message || "Failed to sign in new user", 500);
  }
  const session = sdata.session;
  const user = sdata.user;
  await upsertProfileAfterRegionalLogin(admin, user.id, profilePatch);
  const bodyOut: Record<string, unknown> = {
    userId: user.id,
    accessToken: session.access_token ?? null,
    refreshToken: session.refresh_token ?? null,
    expiresIn: session.expires_in ?? null,
  };
  if (
    oauthClientProfile &&
    (oauthClientProfile.name != null || oauthClientProfile.avatar != null)
  ) {
    bodyOut.oauthProfile = {
      name: oauthClientProfile.name ?? null,
      avatar: oauthClientProfile.avatar ?? null,
    };
  }
  return json(bodyOut);
}

async function handleWechatExchange(body: Record<string, unknown>): Promise<Response> {
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return err("Missing 'code'");

  const appId = (Deno.env.get("WECHAT_APP_ID") || "").trim();
  const secret = (Deno.env.get("WECHAT_APP_SECRET") || "").trim();
  if (!appId || !secret) {
    return err(
      "WeChat is not configured: set WECHAT_APP_ID and WECHAT_APP_SECRET in Edge Function secrets",
      503,
    );
  }

  const tokenUrl =
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appId)}` +
    `&secret=${encodeURIComponent(secret)}&code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  const wxRes = await fetch(tokenUrl);
  const wxJson = (await wxRes.json()) as Record<string, unknown>;
  if (wxJson.errcode != null && Number(wxJson.errcode) !== 0) {
    const msg = String(wxJson.errmsg || "wechat_token_error");
    return err(`WeChat token error: ${msg}`, 401);
  }
  const openid = typeof wxJson.openid === "string" ? wxJson.openid.trim() : "";
  if (!openid) return err("WeChat response missing openid", 502);

  const accessTokenWx = typeof wxJson.access_token === "string"
    ? wxJson.access_token
    : "";

  let nickname: string | null = null;
  let avatar: string | null = null;
  if (accessTokenWx) {
    const uiUrl =
      `https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(accessTokenWx)}` +
      `&openid=${encodeURIComponent(openid)}&lang=zh_CN`;
    const uiRes = await fetch(uiUrl);
    const uiJson = (await uiRes.json()) as Record<string, unknown>;
    if (uiJson.errcode == null || Number(uiJson.errcode) === 0) {
      if (typeof uiJson.nickname === "string") nickname = uiJson.nickname;
      if (typeof uiJson.headimgurl === "string") avatar = uiJson.headimgurl;
    }
  }

  const admin = getAdminClient();
  const profilePatch: Record<string, unknown> = {
    provider: "wechat",
    wechat_openid: openid,
    name: nickname,
    avatar: avatar,
  };

  const oauthHint: OauthClientProfileHint = {
    name: nickname,
    avatar: avatar,
  };
  const existing = await findRegionalIdentity(admin, "wechat", openid);
  if (existing) {
    return finalizeRegionalSession(
      admin,
      existing.user_id,
      existing.login_email,
      profilePatch,
      oauthHint,
    );
  }
  return createRegionalUserAndSession(
    admin,
    "wechat",
    openid,
    profilePatch,
    oauthHint,
  );
}

function normalizeAlipayPrivateKeyPem(raw: string): string {
  let s = raw.trim();
  if (s.includes("\\n")) s = s.replace(/\\n/g, "\n");
  return s;
}

function pemPkcs8ToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function alipayTimestampShanghai(): string {
  return new Date().toLocaleString("sv-SE", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  }).replace("T", " ");
}

async function alipayRsa2Sign(
  content: string,
  privateKeyPem: string,
): Promise<string> {
  const pem = normalizeAlipayPrivateKeyPem(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemPkcs8ToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(content),
  );
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

async function handleAlipayExchange(body: Record<string, unknown>): Promise<Response> {
  const authCodeRaw = body?.auth_code ?? body?.code;
  const authCode = typeof authCodeRaw === "string" ? authCodeRaw.trim() : "";
  if (!authCode) return err("Missing 'code' or 'auth_code'");

  const appId = (Deno.env.get("ALIPAY_APP_ID") || "").trim();
  const pk = (Deno.env.get("ALIPAY_APP_PRIVATE_KEY_PEM") || "").trim();
  const gateway = (Deno.env.get("ALIPAY_GATEWAY_URL") || "").trim() ||
    "https://openapi.alipay.com/gateway.do";

  if (!appId || !pk) {
    return err(
      "Alipay is not configured: set ALIPAY_APP_ID and ALIPAY_APP_PRIVATE_KEY_PEM in Edge Function secrets",
      503,
    );
  }

  const params: Record<string, string> = {
    app_id: appId,
    method: "alipay.system.oauth.token",
    format: "json",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTimestampShanghai(),
    version: "1.0",
    grant_type: "authorization_code",
    code: authCode,
  };

  const signKeys = Object.keys(params).filter((k) => k !== "sign").sort();
  const signContent = signKeys.map((k) => `${k}=${params[k]}`).join("&");
  const sign = await alipayRsa2Sign(signContent, pk);
  params.sign = sign;

  const formBody = new URLSearchParams(params).toString();
  const aliRes = await fetch(gateway, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: formBody,
  });
  const aliText = await aliRes.text();
  let aliJson: Record<string, unknown>;
  try {
    aliJson = JSON.parse(aliText) as Record<string, unknown>;
  } catch {
    return err("Alipay gateway returned non-JSON", 502);
  }

  const tokenResp = aliJson.alipay_system_oauth_token_response as
    | Record<string, unknown>
    | undefined;
  const errResp = aliJson.error_response as Record<string, unknown> | undefined;

  if (errResp && (errResp.code != null || errResp.sub_code != null)) {
    const msg = String(
      errResp.sub_msg || errResp.msg || errResp.message || "alipay_error",
    );
    return err(`Alipay error: ${msg}`, 401);
  }
  if (!tokenResp) {
    return err("Alipay response missing alipay_system_oauth_token_response", 502);
  }
  if (tokenResp.user_id == null && tokenResp.open_id == null) {
    return err("Alipay token response missing user_id", 502);
  }

  const userIdAli = typeof tokenResp.user_id === "string"
    ? tokenResp.user_id
    : typeof tokenResp.open_id === "string"
    ? tokenResp.open_id
    : "";
  if (!userIdAli) return err("Alipay token response missing user id", 502);

  const admin = getAdminClient();
  const profilePatch: Record<string, unknown> = {
    provider: "alipay",
    alipay_user_id: userIdAli,
  };

  const existing = await findRegionalIdentity(admin, "alipay", userIdAli);
  if (existing) {
    return finalizeRegionalSession(
      admin,
      existing.user_id,
      existing.login_email,
      profilePatch,
    );
  }
  return createRegionalUserAndSession(admin, "alipay", userIdAli, profilePatch);
}

// ============================================================================
// LINE OAuth2 exchange — LINE Login v2.1
// ============================================================================
// Flow: client (web or native SDK) gets a LINE authorization code →
//       calls this endpoint → Edge exchanges with LINE API →
//       decodes id_token to get userId (sub) →
//       creates/links Supabase user → returns session.
//
// Secrets: LINE_CHANNEL_ID, LINE_CHANNEL_SECRET (from LINE Developers Console)

async function handleLineExchange(body: Record<string, unknown>): Promise<Response> {
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return err("Missing 'code'");

  const channelId = (Deno.env.get("LINE_CHANNEL_ID") || "").trim();
  const channelSecret = (Deno.env.get("LINE_CHANNEL_SECRET") || "").trim();
  if (!channelId || !channelSecret) {
    return err(
      "LINE is not configured: set LINE_CHANNEL_ID and LINE_CHANNEL_SECRET in Edge Function secrets",
      503,
    );
  }

  // redirect_uri must match the one used in the authorization request.
  // For Capacitor native flows, this is typically a custom scheme.
  // For web flows, this is the app's callback URL.
  const redirectUri =
    typeof body?.redirect_uri === "string" && body.redirect_uri.trim()
      ? body.redirect_uri.trim()
      : "";

  // Exchange authorization code for tokens
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code);
  tokenParams.set("client_id", channelId);
  tokenParams.set("client_secret", channelSecret);
  if (redirectUri) tokenParams.set("redirect_uri", redirectUri);

  const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
  if (!tokenRes.ok) {
    const msg = String(tokenJson.error_description || tokenJson.error || "line_token_error");
    return err(`LINE token error: ${msg}`, 401);
  }

  const idToken = typeof tokenJson.id_token === "string" ? tokenJson.id_token.trim() : "";
  if (!idToken) return err("LINE response missing id_token", 502);

  // Decode id_token (JWT) without verification — Supabase Edge doesn't have
  // access to LINE's JWKS in this context. The token was just obtained from
  // LINE's server over HTTPS with client_secret, so it's trustworthy.
  let lineUserId = "";
  let displayName: string | null = null;
  let pictureUrl: string | null = null;
  try {
    const payloadBase64 = idToken.split(".")[1];
    if (payloadBase64) {
      const decoded = atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(decoded) as Record<string, unknown>;
      lineUserId = typeof payload.sub === "string" ? payload.sub.trim() : "";
      if (typeof payload.name === "string" && payload.name.trim()) {
        displayName = payload.name.trim();
      }
      if (typeof payload.picture === "string" && payload.picture.trim()) {
        pictureUrl = payload.picture.trim();
      }
    }
  } catch {
    // If JWT decoding fails, try getting profile via access_token
  }

  if (!lineUserId) {
    // Fallback: use access_token to get user profile
    const accessToken = typeof tokenJson.access_token === "string"
      ? tokenJson.access_token.trim()
      : "";
    if (accessToken) {
      const profileRes = await fetch("https://api.line.me/v2/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const profileJson = (await profileRes.json()) as Record<string, unknown>;
      if (profileRes.ok && typeof profileJson.userId === "string") {
        lineUserId = profileJson.userId.trim();
        displayName = typeof profileJson.displayName === "string"
          ? profileJson.displayName.trim()
          : displayName;
        pictureUrl = typeof profileJson.pictureUrl === "string"
          ? profileJson.pictureUrl.trim()
          : pictureUrl;
      }
    }
  }

  if (!lineUserId) return err("Could not determine LINE user ID", 502);

  const admin = getAdminClient();
  const profilePatch: Record<string, unknown> = {
    provider: "line",
    line_user_id: lineUserId,
    name: displayName,
    avatar: pictureUrl,
  };

  const oauthHint = {
    name: displayName,
    avatar: pictureUrl,
  };

  const existing = await findRegionalIdentity(admin, "line", lineUserId);
  if (existing) {
    return finalizeRegionalSession(
      admin,
      existing.user_id,
      existing.login_email,
      profilePatch,
      oauthHint,
    );
  }
  return createRegionalUserAndSession(admin, "line", lineUserId, profilePatch, oauthHint);
}

// ============================================================================
// Profile handlers
// ============================================================================

async function handleGetProfile(user: User): Promise<Response> {
  const admin = getAdminClient();
  const userId = user.id;
  const avatarFromOAuth = oauthAvatarFromUserMetadata(user);

  const { data, error } = await admin
    .from("user_profiles")
    .select(
      "profile, updated_at, content_role, content_super_admin, app_role, display_name, phone, pickup_address, avatar_url, profile_completed",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[profile/GET] DB error:", error);
    return err(`Database error: ${error.message}`, 500);
  }

  if (!data) {
    // First-time login via OAuth (Google / Facebook / Apple / X etc.) —
    // auto-create a user_profiles row seeded with OAuth metadata so the
    // client sees the Google name/avatar immediately, and subsequent
    // ProfilePage form edits are persisted via POST /profile.
    const meta = (user.user_metadata || {}) as Record<string, unknown>;
    const oauthName =
      (typeof meta.full_name === "string" && meta.full_name.trim()) ||
      (typeof meta.name === "string" && meta.name.trim()) ||
      (user.email ? user.email.split("@")[0] : "") ||
      "";
    const oauthEmail = (user.email ?? null) as string | null;
    const nowIso = new Date().toISOString();
    const extras: Record<string, unknown> = {};
    if (oauthEmail) extras.email = oauthEmail;
    // Detect which providers are linked from app_metadata / user_metadata
    try {
      const providers: string[] = user.app_metadata?.providers || [];
      if (providers.length > 0) extras.provider = providers[0];
    } catch { /* ignore */ }

    const { error: insertErr } = await admin
      .from("user_profiles")
      .upsert(
        {
          user_id: userId,
          profile: extras,
          display_name: oauthName.slice(0, DISPLAY_NAME_MAX),
          avatar_url: avatarFromOAuth.slice(0, AVATAR_URL_MAX_CHARS),
          phone: "",
          pickup_address: "",
          profile_completed: false,
          updated_at: nowIso,
        },
        { onConflict: "user_id" },
      );

    if (insertErr) {
      console.error("[profile/GET] auto-create user_profiles failed:", insertErr);
    }

    return json({
      profile: extras,
      profileExtras: extras,
      displayName: oauthName.slice(0, DISPLAY_NAME_MAX),
      phone: "",
      pickupAddress: "",
      avatarUrl: avatarFromOAuth,
      profileCompleted: false,
      contentRole: "none",
      appRole: "farmer",
    });
  }

  const appRole =
    data.app_role === "distributor" ? "distributor" : "farmer";

  const rawProf =
    data.profile && typeof data.profile === "object" && !Array.isArray(data.profile)
      ? (data.profile as Record<string, unknown>)
      : {};
  const profileExtras = stripColumnKeysFromProfileJson(rawProf);

  const dn = data.display_name ?? "";
  const ph = data.phone ?? "";
  const pu = data.pickup_address ?? "";
  const dbAvatar =
    typeof data.avatar_url === "string" ? data.avatar_url.trim() : "";
  const mergedAvatar = dbAvatar || avatarFromOAuth;
  const profileCompleted = computeProfileCompleted(dn, ph, pu);

  return json({
    profile: profileExtras,
    profileExtras,
    displayName: dn,
    phone: ph,
    pickupAddress: pu,
    avatarUrl: mergedAvatar,
    profileCompleted,
    updatedAt: data.updated_at,
    contentRole: (data.content_role || "none"),
    appRole,
  });
}

function sanitizeLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  // 宽松 BCP-47 形态：字母、数字、连字符，长度上限 16（如 zh-Hans-CN 也能容）。
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/.test(s)) return null;
  return s.slice(0, 16);
}

async function handlePushSubscribe(
  body: Record<string, unknown>,
  userId: string,
): Promise<Response> {
  const admin = getAdminClient();
  const language = sanitizeLanguage(body?.language);

  if (body?.platform === "fcm" && typeof body?.token === "string") {
    const token = (body.token as string).trim();
    if (token.length < 10) return err("Invalid FCM token");
    await admin.from("push_subscriptions").delete().eq("user_id", userId).eq(
      "platform",
      "fcm",
    ).eq("fcm_token", token);
    const { error } = await admin.from("push_subscriptions").insert({
      user_id: userId,
      platform: "fcm",
      fcm_token: token,
      endpoint: null,
      p256dh: null,
      auth: null,
      language,
    });
    if (error) {
      console.error("[push/subscribe] fcm insert", error);
      return err(`Database error: ${error.message}`, 500);
    }
    return json({ ok: true, platform: "fcm" });
  }

  if (body?.platform === "jpush" && typeof body?.token === "string") {
    const token = (body.token as string).trim();
    if (token.length < 10) return err("Invalid JPush registration ID");
    await admin.from("push_subscriptions").delete().eq("user_id", userId).eq(
      "platform",
      "jpush",
    ).eq("fcm_token", token);
    const { error } = await admin.from("push_subscriptions").insert({
      user_id: userId,
      platform: "jpush",
      fcm_token: token,
      endpoint: null,
      p256dh: null,
      auth: null,
      language,
    });
    if (error) {
      console.error("[push/subscribe] jpush insert", error);
      return err(`Database error: ${error.message}`, 500);
    }
    return json({ ok: true, platform: "jpush" });
  }

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const keys = body?.keys as { p256dh?: string; auth?: string } | undefined;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return err(
      "Expected Web Push JSON { endpoint, keys: { p256dh, auth } } or { platform: \"fcm\", token }",
    );
  }

  await admin.from("push_subscriptions").delete().eq("user_id", userId).eq(
    "platform",
    "webpush",
  ).eq("endpoint", endpoint);

  const { error } = await admin.from("push_subscriptions").insert({
    user_id: userId,
    platform: "webpush",
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    fcm_token: null,
    language,
  });

  if (error) {
    console.error("[push/subscribe] webpush insert", error);
    return err(`Database error: ${error.message}`, 500);
  }
  return json({ ok: true, platform: "webpush" });
}

async function handlePushUnsubscribe(
  body: Record<string, unknown>,
  userId: string,
): Promise<Response> {
  const admin = getAdminClient();

  if (body?.platform === "fcm" && typeof body?.token === "string") {
    const token = (body.token as string).trim();
    await admin.from("push_subscriptions").delete().eq("user_id", userId).eq(
      "platform",
      "fcm",
    ).eq("fcm_token", token);
    return json({ ok: true });
  }

  if (body?.platform === "jpush" && typeof body?.token === "string") {
    const token = (body.token as string).trim();
    await admin.from("push_subscriptions").delete().eq("user_id", userId).eq(
      "platform",
      "jpush",
    ).eq("fcm_token", token);
    return json({ ok: true });
  }

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    return err("Expected { endpoint } or { platform: \"fcm\", token }");
  }

  await admin.from("push_subscriptions").delete().eq("user_id", userId).eq(
    "platform",
    "webpush",
  ).eq("endpoint", endpoint);
  return json({ ok: true });
}

/**
 * POST /push/send — CMS 推送广播（content_admin/editor only）
 *
 * 遍历 push_subscriptions 表中所有订阅，按 platform 分发到对应推送通道。
 * 当前支持：webpush (VAPID) / fcm (FCM v1) / jpush (极光)。
 * 失败订阅自动清理（stale token / 410 / 404 / 极光错误码 1011）。
 */
async function handlePushSend(body: any): Promise<Response> {
  const title = String(body?.title || "").trim();
  const bodyText = String(body?.body || "").trim();
  const url = String(body?.url || "").trim();
  const image = String(body?.image || "").trim();

  if (!title || !bodyText) {
    return err("Missing title or body", 400);
  }

  const admin = getAdminClient();
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("id, platform, endpoint, p256dh, auth, fcm_token, language");

  if (error || !subs) {
    return err(`Query error: ${error?.message || "no data"}`, 500);
  }

  let sent = 0;
  let errors = 0;
  const results: string[] = [];
  const data: Record<string, string> = {};
  if (url) data.url = url;
  if (image) data.image = image;
  const webOk = configureWebPushOnce();

  for (const row of subs) {
    const platform = String((row as any).platform || "webpush");
    const rowId = (row as any).id;
    const rowLanguage = (row as any).language || null;
    const strings = pickStrings(rowLanguage);

    try {
      if (platform === "fcm") {
        const tok = (row as any).fcm_token;
        if (!tok || tok.length < 10) continue;
        const fcmRes = await sendFcmV1(tok, title, bodyText, data);
        if (fcmRes.ok) {
          sent++;
        } else if (fcmRes.stale) {
          await admin.from("push_subscriptions").delete().eq("id", rowId);
          results.push(`fcm: stale removed`);
        }
      } else if (platform === "jpush") {
        const regId = (row as any).fcm_token;
        if (!regId || regId.length < 10) continue;
        const jpRes = await sendJpush(regId, title, bodyText, data);
        if (jpRes.ok) {
          sent++;
        } else if (jpRes.stale) {
          await admin.from("push_subscriptions").delete().eq("id", rowId);
          results.push(`jpush: stale removed`);
        }
      } else if (platform === "webpush" && webOk) {
        const endpoint = (row as any).endpoint;
        const p256dh = (row as any).p256dh;
        const auth = (row as any).auth;
        if (!endpoint || !p256dh || !auth) continue;
        try {
          await webpush.sendNotification(
            { endpoint, keys: { p256dh, auth } } as unknown as webpush.PushSubscription,
            JSON.stringify({ title, body: bodyText, ...data }),
            { TTL: 86400 },
          );
          sent++;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push(`webpush: ${msg}`);
          const statusCode = (e as { statusCode?: number })?.statusCode;
          if (statusCode === 410 || statusCode === 404) {
            await admin.from("push_subscriptions").delete().eq("id", rowId);
          }
        }
      }
    } catch (e: any) {
      errors++;
      results.push(`${platform}: ${e.message}`);
    }
  }

  return json({
    ok: true,
    total: subs.length,
    sent,
    errors,
    results: results.slice(0, 10),
  });
}

async function handlePostProfile(
  body: any,
  authenticatedUserId: string,
): Promise<Response> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return err("Invalid body");
  }

  const admin = getAdminClient();

  const { data: row, error: readErr } = await admin
    .from("user_profiles")
    .select(
      "profile, display_name, avatar_url, phone, pickup_address, profile_completed, last_profile_post_at",
    )
    .eq("user_id", authenticatedUserId)
    .maybeSingle();

  if (readErr) {
    console.error("[profile/POST] read:", readErr);
    return err(`Database error: ${readErr.message}`, 500);
  }

  const intervalSec = getProfilePostMinIntervalSeconds();
  if (intervalSec > 0 && row?.profile_completed === true) {
    const lastRaw = row.last_profile_post_at as string | null | undefined;
    if (lastRaw) {
      const lastMs = new Date(lastRaw).getTime();
      if (Number.isFinite(lastMs)) {
        const elapsed = (Date.now() - lastMs) / 1000;
        if (elapsed < intervalSec) {
          const retryAfter = Math.max(1, Math.ceil(intervalSec - elapsed));
          return json(
            {
              error: "Profile update rate limited. Try again later.",
              retryAfterSeconds: retryAfter,
            },
            429,
            { "Retry-After": String(retryAfter) },
          );
        }
      }
    }
  }

  const prevProf =
    row?.profile && typeof row.profile === "object" && !Array.isArray(row.profile)
      ? (row.profile as Record<string, unknown>)
      : {};

  let display_name = typeof row?.display_name === "string" ? row.display_name : "";
  let avatar_url = typeof row?.avatar_url === "string" ? row.avatar_url : "";
  let phone = typeof row?.phone === "string" ? row.phone : "";
  let pickup_address = typeof row?.pickup_address === "string"
    ? row.pickup_address
    : "";

  const legacy = body.profile && typeof body.profile === "object" &&
      !Array.isArray(body.profile)
    ? body.profile as Record<string, unknown>
    : null;

  if (typeof body.displayName === "string") {
    display_name = body.displayName.trim().slice(0, DISPLAY_NAME_MAX);
  } else if (legacy && typeof legacy.name === "string") {
    display_name = legacy.name.trim().slice(0, DISPLAY_NAME_MAX);
  }

  if (typeof body.phone === "string") {
    phone = sanitizePhoneColumn(body.phone);
  } else if (legacy && "phone" in legacy) {
    phone = sanitizePhoneColumn(legacy.phone);
  }

  if (typeof body.pickupAddress === "string") {
    pickup_address = clipPickupAddress(body.pickupAddress);
  } else if (legacy && typeof legacy.pickup_address === "string") {
    pickup_address = clipPickupAddress(legacy.pickup_address);
  } else if (legacy && typeof legacy.pickupAddress === "string") {
    pickup_address = clipPickupAddress(legacy.pickupAddress);
  }

  if (typeof body.avatarUrl === "string") {
    const t = body.avatarUrl.trim();
    if (
      t &&
      (isHttpUrl(t) || t.startsWith("data:image/")) &&
      t.length <= AVATAR_URL_MAX_CHARS
    ) {
      avatar_url = t.slice(0, AVATAR_URL_MAX_CHARS);
    }
  } else if (legacy && typeof legacy.avatar === "string") {
    const t = legacy.avatar.trim();
    if (
      t &&
      (isHttpUrl(t) || t.startsWith("data:image/")) &&
      t.length <= AVATAR_URL_MAX_CHARS
    ) {
      avatar_url = t.slice(0, AVATAR_URL_MAX_CHARS);
    }
  }

  const extras = stripColumnKeysFromProfileJson({
    ...prevProf,
    ...(legacy || {}),
  });

  const profile_completed = computeProfileCompleted(
    display_name,
    phone,
    pickup_address,
  );

  const nowIso = new Date().toISOString();
  const { error } = await admin.from("user_profiles").upsert(
    {
      user_id: authenticatedUserId,
      profile: extras,
      display_name,
      avatar_url,
      phone,
      pickup_address,
      profile_completed,
      updated_at: nowIso,
      last_profile_post_at: nowIso,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[profile/POST] DB error:", error);
    return err(`Database error: ${error.message}`, 500);
  }

  return json({ success: true, profileCompleted: profile_completed });
}

// ============================================================================
// Account deletion
// ============================================================================

const ACCOUNT_DELETE_RL_MAX = 3;
const ACCOUNT_DELETE_RL_MS = 86400000;

function deletedSenderIdForUser(userId: string): string {
  return `deleted:${userId.slice(0, 8)}`;
}

async function handleAccountDelete(userId: string): Promise<Response> {
  const admin = getAdminClient();

  const { data: profRow, error: profErr } = await admin
    .from("user_profiles")
    .select("profile")
    .eq("user_id", userId)
    .maybeSingle();
  if (profErr) {
    console.error("[account/delete] profile read:", profErr);
    return err("Database error", 500);
  }

  const profile = (profRow?.profile || {}) as Record<string, unknown>;
  const rawAttempts = profile.account_delete_attempts;
  const attempts = Array.isArray(rawAttempts)
    ? rawAttempts.filter((t): t is string => typeof t === "string")
    : [];
  const cutoff = Date.now() - ACCOUNT_DELETE_RL_MS;
  const recentAttempts = attempts.filter((t) => {
    const ms = Date.parse(t);
    return Number.isFinite(ms) && ms >= cutoff;
  });
  if (recentAttempts.length >= ACCOUNT_DELETE_RL_MAX) {
    return err("Account deletion rate limited. Try again later.", 429);
  }

  const nextAttempts = [...recentAttempts, new Date().toISOString()].slice(-10);
  if (profRow) {
    const { error: rlErr } = await admin
      .from("user_profiles")
      .update({ profile: { ...profile, account_delete_attempts: nextAttempts } })
      .eq("user_id", userId);
    if (rlErr) console.error("[account/delete] rate-limit record:", rlErr);
  }

  const anonymizedSender = deletedSenderIdForUser(userId);

  const { error: pushErr } = await admin
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId);
  if (pushErr) console.error("[account/delete] push_subscriptions:", pushErr);

  const { error: chatErr } = await admin
    .from("chat_messages")
    .update({ sender_id: anonymizedSender })
    .eq("sender_id", userId);
  if (chatErr) console.error("[account/delete] chat_messages:", chatErr);

  const { error: farmerChErr } = await admin
    .from("merchant_farmer_channels")
    .delete()
    .eq("farmer_user_id", userId);
  if (farmerChErr) console.error("[account/delete] merchant_farmer_channels:", farmerChErr);

  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    console.error("[account/delete] deleteUser:", delErr);
    return err(delErr.message || "Failed to delete account", 500);
  }

  return json({ ok: true });
}