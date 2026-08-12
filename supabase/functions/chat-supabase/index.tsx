// ============================================================================
// chat-supabase — Supabase 聊天：消息写入、历史、媒体上传
// ============================================================================
// 安全模型（生产必看）：
//   - 所有 mutating 与 GET /messages 需要 Authorization: Bearer <用户 access_token>
//     （Supabase Auth 登录后下发的 JWT，不是 anon key）
//   - sender_id 一律以 JWT 中的 user.id 为准，忽略客户端传入的 sender_id（防伪造）
//   - 频道：merchant_farmer_channels 中该 channel_id 对应行的 merchant_user_id 或 farmer_user_id
//     与当前 JWT 用户一致（双方会话；禁止「第三者」抢首条或窥视）
//   - 可选 CHAT_RELAX_CHANNEL_AUTH=true（仅开发/内网）：已登录即可访问任意 channel（勿用于公网）
//   - POST /messages/delete：需 Authorization 用户 JWT + 同上频道权限
//   - 可选 CHAT_DELETE_SECRET：若设置，请求头 X-Chat-Delete-Secret 与其一致时可删任意 channel（运维脚本）或 POST /admin/purge-old（按保留天数清理 chat_messages + chat-media）
//   - 云端保留窗口：默认 3 天（CHAT_RETENTION_DAYS / POST /admin/purge-old body.days 可覆盖；
//     与 migrations/001_init.sql 中 pg_cron 任务对齐）；客户端 IndexedDB（chatLocalStore）长期保留
//
// POST /messages     JSON { channel_id, sender_id(忽略), msg_type, body?, media_url?, duration_ms? }
//                    写入成功后向 Realtime 频道 chat:{channel_id} 发 broadcast(event=message, payload=inserted)
// GET  /messages     ?channel_id=&limit=50&before=<iso>
//                    或 ?channel_id=&since=<iso>&limit=200：created_at > since 升序返回（断线重连增量补拉）
// POST /messages/delete  JSON { channel_id }
// POST /admin/purge-old  JSON { days?=1, includeStorage?=true } — 需 X-Chat-Delete-Secret（同 CHAT_DELETE_SECRET），无用户 JWT。默认 1 天 + 同时清 Storage（与 pg_cron 行为一致）
// POST /upload       multipart: file, channel_id, sender_id(忽略), kind=image|voice|video
//                    [LEGACY] 媒体经 Edge 代理。新客户端走 /upload/sign + 直传 Storage。
// POST /upload/sign  JSON { channel_id, kind=image|voice|video, ext } →
//                    { uploadUrl, token, objectPath, publicUrl }
//                    客户端直传 Storage：PUT uploadUrl，header x-upsert: false。
//
// 环境：SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// 推送分发（写库成功后内联 dispatchPushFromChat，见 ../_shared/push.ts）：
//   Web Push: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
//   FCM v1:   FCM_SERVICE_ACCOUNT_JSON（project_id 从 JSON 中自动提取）
//   可选开关: CHAT_INLINE_PUSH=false（禁用内联推送；通常不需要）
// 可选：CHAT_RELAX_CHANNEL_AUTH, CHAT_DELETE_SECRET, CHAT_RETENTION_DAYS,
//       CHAT_INSECURE_OPEN_READ — "true" 时：GET /messages 放宽为「channel 已在 merchant_farmer_channels
//       登记则任意已登录用户可读」（旧行为，依赖 channel_id 保密）。默认不设置 = 仅绑定双方可读。
//       （已弃用：CHAT_STRICT_BOUND_CHANNEL_READ，请改用默认严格读或本变量。）
// 防刷（可与 Cloudflare IP 限流叠加，见 farmer-developer/DEPLOY_GUIDE_CN.md）：
//   CHAT_RL_ENABLED — "false" 时关闭服务端聊天限流（仅开发调试用）；默认开启
//   CHAT_RL_MSG_PER_MIN / CHAT_RL_MSG_PER_DAY — 按用户统计 chat_messages 条数
//   CHAT_RL_PER_CHANNEL — "true" 时上述额度按 channel 维度；否则按用户全局
//   CHAT_RL_SIGN_PER_MIN — POST /upload/sign 每分钟上限（计数表 chat_rl_upload_sign）
//   CHAT_RL_NEW_ACCOUNT_HOURS — 若 >0：账号创建未满该小时数视为新号，用下方更严配额
//   CHAT_RL_MSG_PER_MIN_NEW / CHAT_RL_MSG_PER_DAY_NEW — 新号消息配额（默认 10 / 100）
//   CHAT_RL_FAIL_CLOSED — "true" 时 DB 计数失败返回 429（默认 fail-open 以免误伤）
// ============================================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.49.8";
import { dispatchPushFromChat } from "../_shared/push.ts";

// Supabase Edge Runtime exposes EdgeRuntime.waitUntil for fire-and-forget tasks.
// Declared loosely so type-check elsewhere doesn't break.
declare const EdgeRuntime: { waitUntil: (p: Promise<unknown>) => void } | undefined;
function waitUntil(p: Promise<unknown>): void {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(p);
      return;
    }
  } catch {
    // fall through to fire-and-forget
  }
  void p.catch((e) => console.warn("[chat-supabase] background task error", e));
}

function corsHeaders(): Record<string, string> {
  const allow = Deno.env.get("CHAT_ALLOWED_ORIGIN")?.trim();
  return {
    "Access-Control-Allow-Origin": allow || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, x-client-info, x-chat-delete-secret",
  };
}

const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_VOICE = 8 * 1024 * 1024;
const MAX_VIDEO = 50 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function getRoute(req: Request): string {
  const url = new URL(req.url);
  return url.pathname.replace(/^\/chat-supabase/, "") || "/";
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

/** 从 Authorization 取出 JWT；拒绝把 anon key 当作用户 token */
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

function chatRlEnabled(): boolean {
  return Deno.env.get("CHAT_RL_ENABLED") !== "false";
}

/** 到下一 UTC 日界秒数（用于日配额 429） */
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

type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

async function isNewAccount(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const hours = envInt("CHAT_RL_NEW_ACCOUNT_HOURS", 0);
  if (hours <= 0) return false;
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user?.created_at) return false;
    const created = new Date(data.user.created_at).getTime();
    return Date.now() - created < hours * 3600_000;
  } catch {
    return false;
  }
}

/**
 * 基于已有 chat_messages 行统计：近 1 分钟 + UTC 自然日（可选按 channel）。
 * 新号（CHAT_RL_NEW_ACCOUNT_HOURS）可用更严配额。
 */
async function enforceChatMessageRateLimit(
  admin: SupabaseClient,
  userId: string,
  channelId: string,
): Promise<RateLimitResult> {
  if (!chatRlEnabled()) return { ok: true };

  const newAcct = await isNewAccount(admin, userId);
  const perMin = newAcct
    ? envInt("CHAT_RL_MSG_PER_MIN_NEW", 10)
    : envInt("CHAT_RL_MSG_PER_MIN", 30);
  const perDay = newAcct
    ? envInt("CHAT_RL_MSG_PER_DAY_NEW", 100)
    : envInt("CHAT_RL_MSG_PER_DAY", 500);
  const perChannel = Deno.env.get("CHAT_RL_PER_CHANNEL") === "true";

  const sinceMin = new Date(Date.now() - 60_000).toISOString();
  let qMin = admin
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("sender_id", userId)
    .gt("created_at", sinceMin);
  if (perChannel) qMin = qMin.eq("channel_id", channelId);
  const { count: cMin, error: eMin } = await qMin;
  if (eMin) {
    console.error("[chat-supabase] CHAT_RL count/min failed", eMin);
    if (chatRlFailClosed()) return { ok: false, retryAfter: 60 };
    return { ok: true };
  }
  if ((cMin ?? 0) >= perMin) {
    return { ok: false, retryAfter: 60 };
  }

  const startUtc = new Date();
  startUtc.setUTCHours(0, 0, 0, 0);
  let qDay = admin
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("sender_id", userId)
    .gte("created_at", startUtc.toISOString());
  if (perChannel) qDay = qDay.eq("channel_id", channelId);
  const { count: cDay, error: eDay } = await qDay;
  if (eDay) {
    console.error("[chat-supabase] CHAT_RL count/day failed", eDay);
    if (chatRlFailClosed()) {
      return { ok: false, retryAfter: secondsUntilUtcMidnight() };
    }
    return { ok: true };
  }
  if ((cDay ?? 0) >= perDay) {
    return { ok: false, retryAfter: secondsUntilUtcMidnight() };
  }

  return { ok: true };
}

/** POST /upload/sign：按 chat_rl_upload_sign 行统计近 1 分钟 */
async function enforceUploadSignRateLimit(
  admin: SupabaseClient,
  userId: string,
): Promise<RateLimitResult> {
  if (!chatRlEnabled()) return { ok: true };

  const perMin = envInt("CHAT_RL_SIGN_PER_MIN", 20);
  const sinceMin = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await admin
    .from("chat_rl_upload_sign")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gt("created_at", sinceMin);
  if (error) {
    console.error("[chat-supabase] CHAT_RL sign count failed", error);
    if (chatRlFailClosed()) return { ok: false, retryAfter: 60 };
    return { ok: true };
  }
  if ((count ?? 0) >= perMin) {
    return { ok: false, retryAfter: 60 };
  }
  return { ok: true };
}

/** 当前用户是否为该 channel 在 merchant_farmer_channels 中的商户或农户（唯一合法参与者）。 */
async function isChannelMember(
  admin: SupabaseClient,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const uid = userId.trim();
  const farmerKey = uid.toLowerCase();
  const { data: asMerchant } = await admin
    .from("merchant_farmer_channels")
    .select("id")
    .eq("channel_id", channelId)
    .eq("merchant_user_id", uid)
    .maybeSingle();
  if (asMerchant) return true;
  const { data: asFarmer } = await admin
    .from("merchant_farmer_channels")
    .select("id")
    .eq("channel_id", channelId)
    .eq("farmer_user_id", farmerKey)
    .maybeSingle();
  return !!asFarmer;
}

/** 写消息 / 上传 / 删消息：开发放宽或正式成员校验。 */
async function canMutateChannel(
  admin: SupabaseClient,
  channelId: string,
  userId: string,
): Promise<boolean> {
  if (Deno.env.get("CHAT_RELAX_CHANNEL_AUTH") === "true") {
    console.warn("[chat-supabase] CHAT_RELAX_CHANNEL_AUTH is on — not for public production");
    return true;
  }
  return isChannelMember(admin, channelId, userId);
}

/**
 * GET /messages：默认仅绑定双方可读。设 CHAT_INSECURE_OPEN_READ=true 恢复旧行为（任意已登录用户
 * 只要 channel 已登记即可读，依赖 channel_id 保密）。
 */
async function userCanReadChannel(
  admin: SupabaseClient,
  channelId: string,
  userId: string,
): Promise<boolean> {
  if (await isChannelMember(admin, channelId, userId)) return true;
  if (Deno.env.get("CHAT_INSECURE_OPEN_READ") === "true") {
    const { data } = await admin
      .from("merchant_farmer_channels")
      .select("id")
      .eq("channel_id", channelId)
      .maybeSingle();
    return !!data;
  }
  return false;
}

function deleteSecretOk(req: Request): boolean {
  const secret = (Deno.env.get("CHAT_DELETE_SECRET") || "").trim();
  if (!secret || secret.length < 16) return false;
  const h = (req.headers.get("x-chat-delete-secret") || "").trim();
  return h.length > 0 && timingSafeEqual(h, secret);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** 与 /upload/sign objectPath 前缀一致 */
function sanitizeChannelIdForStorage(channelId: string): string {
  return channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 非文本消息的 media_url 必须指向本 channel 的 chat-media 公开路径 */
function isValidChatMediaUrl(mediaUrl: string, channelId: string): boolean {
  const trimmed = mediaUrl.trim();
  if (!trimmed || !channelId.trim()) return false;
  const sanitized = sanitizeChannelIdForStorage(channelId);
  const requiredSegment = `/storage/v1/object/public/chat-media/${sanitized}/`;
  try {
    const parsed = trimmed.startsWith("http")
      ? new URL(trimmed)
      : new URL(trimmed, "https://local.invalid");
    const idx = parsed.pathname.indexOf(requiredSegment);
    if (idx < 0) return false;
    const after = parsed.pathname.slice(idx + requiredSegment.length);
    if (!after || after.includes("..") || after.startsWith("/")) return false;
    return true;
  } catch {
    return false;
  }
}

function chatRlFailClosed(): boolean {
  return Deno.env.get("CHAT_RL_FAIL_CLOSED") === "true";
}

/**
 * 写入成功后通过 Realtime HTTP API 向 chat:{channel_id} 频道广播消息。
 * 客户端 .on('broadcast', { event: 'message' }, ...) 即可收到 payload。
 * 失败仅记录日志，不影响主流程 200 响应（客户端可通过 since 增量补拉兜底）。
 */
async function broadcastChatMessage(
  channelId: string,
  inserted: unknown,
): Promise<void> {
  const url = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return;
  try {
    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `chat:${channelId}`,
            event: "message",
            payload: inserted,
          },
        ],
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("[chat-supabase] broadcast non-2xx", res.status, txt);
    }
  } catch (e) {
    console.warn("[chat-supabase] broadcast failed", e);
  }
}

/**
 * 写库成功后 fire-and-forget 分发推送：直接调用 _shared/push.ts，完成 Web Push + FCM v1。
 * 调用方使用 waitUntil(maybeNotifyPushAsync(...)) 而非 await：
 *   - 主请求立即 return 200，客户端不等待 push；
 *   - Edge runtime 仍在 background 执行直到 promise resolve，避免函数早退。
 * 特殊情况下可通过 CHAT_INLINE_PUSH=false 关闭（通常不需要）。
 */
async function maybeNotifyPushAsync(
  admin: SupabaseClient,
  channelId: string,
  senderId: string,
  msgType: string,
  body: string | null,
): Promise<void> {
  if ((Deno.env.get("CHAT_INLINE_PUSH") ?? "true").toLowerCase() === "false") return;
  try {
    await dispatchPushFromChat(admin, {
      channelId,
      senderId,
      msgType,
      preview: body?.slice(0, 120) ?? "",
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[chat-supabase] dispatchPushFromChat failed", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const route = getRoute(req);

  try {
    if (route === "/health" && req.method === "GET") {
      return json({ status: "ok", service: "chat-supabase" });
    }

    const jwt = extractUserJwt(req);
    const userId = jwt ? await getAuthUserId(jwt) : null;

    if (route === "/messages" && req.method === "GET") {
      const url = new URL(req.url);
      const channelId = (url.searchParams.get("channel_id") || "").trim();
      const before = url.searchParams.get("before");
      const since = url.searchParams.get("since");
      if (!channelId) return err("Missing channel_id");
      if (!userId) {
        return err("Unauthorized: sign in and send Authorization: Bearer <access_token>", 401);
      }

      const admin = adminClient();
      if (!(await userCanReadChannel(admin, channelId, userId))) {
        return err("Forbidden: not a participant of this channel", 403);
      }

      // 增量补拉模式：created_at > since 升序，默认 limit 200（上限 500）
      if (since) {
        const rawLimit =
          parseInt(url.searchParams.get("limit") || "200", 10) || 200;
        const limit = Math.min(500, Math.max(1, rawLimit));
        const { data, error } = await admin
          .from("chat_messages")
          .select(
            "id, channel_id, sender_id, msg_type, body, media_url, duration_ms, created_at",
          )
          .eq("channel_id", channelId)
          .gt("created_at", since)
          .order("created_at", { ascending: true })
          .limit(limit);
        if (error) {
          console.error("[chat-supabase] list since", error);
          return err("Database error", 500);
        }
        return json({ messages: data || [] });
      }

      // 历史分页模式（默认/?before=<iso>）：倒序取最近 N 条，再反转为升序返回
      const limit = Math.min(
        100,
        Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50),
      );
      let q = admin
        .from("chat_messages")
        .select(
          "id, channel_id, sender_id, msg_type, body, media_url, duration_ms, created_at",
        )
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (before) {
        q = q.lt("created_at", before);
      }

      const { data, error } = await q;
      if (error) {
        console.error("[chat-supabase] list", error);
        return err("Database error", 500);
      }
      return json({ messages: (data || []).reverse() });
    }

    if (route === "/messages" && req.method === "POST") {
      if (!userId) {
        return err("Unauthorized: sign in and send Authorization: Bearer <access_token>", 401);
      }

      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return err("Invalid JSON");

      const channelId = String(body.channel_id || "").trim();
      const msgType = String(body.msg_type || "").trim() as
        | "text"
        | "image"
        | "voice"
        | "video";
      const textBody = body.body != null ? String(body.body) : null;
      const mediaUrl = body.media_url != null ? String(body.media_url) : null;
      const durationMs = body.duration_ms != null
        ? Number(body.duration_ms)
        : null;

      if (!channelId) return err("Missing channel_id");
      if (!["text", "image", "voice", "video"].includes(msgType)) {
        return err("Invalid msg_type");
      }

      const admin = adminClient();
      if (!(await canMutateChannel(admin, channelId, userId))) {
        return err(
          "Forbidden: not a participant of this channel. Bind via merchant QR, or set CHAT_RELAX_CHANNEL_AUTH for dev.",
          403,
        );
      }

      const msgRl = await enforceChatMessageRateLimit(admin, userId, channelId);
      if (!msgRl.ok) {
        return json(
          { error: "CHAT_RATE_LIMIT", retry_after_seconds: msgRl.retryAfter },
          429,
        );
      }

      if (msgType === "text") {
        if (!textBody?.trim()) return err("Empty text body");
      } else {
        if (!mediaUrl?.trim()) return err("Missing media_url");
        if (!isValidChatMediaUrl(mediaUrl, channelId)) {
          return err("Invalid media_url: must be chat-media public path for this channel", 400);
        }
      }

      const senderId = userId;

      const { data: inserted, error } = await admin
        .from("chat_messages")
        .insert({
          channel_id: channelId,
          sender_id: senderId,
          msg_type: msgType,
          body: msgType === "text" ? textBody : null,
          media_url: msgType === "text" ? null : mediaUrl,
          duration_ms: Number.isFinite(durationMs) ? durationMs : null,
        })
        .select("id, channel_id, sender_id, msg_type, body, media_url, duration_ms, created_at")
        .single();

      if (error) {
        console.error("[chat-supabase] insert", error);
        return err("Insert failed", 500);
      }

      await broadcastChatMessage(channelId, inserted);

      // B4: push 分发改为后台执行，主请求立即返回；内联 _shared/push.ts 在 background 跑。
      // 非文本消息传 null 作为 preview —— _shared/push.ts 会按收件人语言替换成 [图片]/[语音]/[视频] 占位符。
      waitUntil(
        maybeNotifyPushAsync(
          admin,
          channelId,
          senderId,
          msgType,
          msgType === "text" ? textBody : null,
        ),
      );

      return json({ message: inserted });
    }

    if (route === "/messages/delete" && req.method === "POST") {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const channelId = String(body?.channel_id || "").trim();
      if (!channelId) return err("Missing channel_id");

      const admin = adminClient();

      if (deleteSecretOk(req)) {
        const { error } = await admin.from("chat_messages").delete().eq("channel_id", channelId);
        if (error) {
          console.error("[chat-supabase] delete messages", error);
          return err("Delete failed", 500);
        }
        return json({ ok: true });
      }

      if (!userId) {
        return err("Unauthorized", 401);
      }
      if (!(await canMutateChannel(admin, channelId, userId))) {
        return err("Forbidden", 403);
      }

      const { error } = await admin.from("chat_messages").delete().eq("channel_id", channelId);
      if (error) {
        console.error("[chat-supabase] delete messages", error);
        return err("Delete failed", 500);
      }
      return json({ ok: true });
    }

    if (route === "/admin/purge-old" && req.method === "POST") {
      if (!deleteSecretOk(req)) {
        return err("Unauthorized", 401);
      }
      // 默认保留 3 天（CHAT_RETENTION_DAYS / body.days 可覆盖；与 pg_cron 任务对齐）
      // 客户端 IndexedDB（chatLocalStore）长期保留消息与媒体，云端仅作短期同步窗口
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const envDays = Number(Deno.env.get("CHAT_RETENTION_DAYS"));
      const rawDays = body.days ?? (Number.isFinite(envDays) ? envDays : 3);
      const days = Math.min(365, Math.max(1, Number(rawDays) || 1));
      const includeStorage = body.includeStorage !== false; // 默认 true；明确传 false 才跳过

      const admin = adminClient();
      const { data: deletedMessages, error: msgErr } = await admin.rpc(
        "purge_chat_messages_older_than",
        { p_days: days },
      );
      if (msgErr) {
        console.error("[chat-supabase] purge-old messages", msgErr);
        return err("Purge failed", 500);
      }

      let deletedStorage: number | null = null;
      if (includeStorage) {
        const { data: ds, error: stErr } = await admin.rpc(
          "purge_chat_media_storage_older_than",
          { p_days: days },
        );
        if (stErr) {
          console.error("[chat-supabase] purge-old storage", stErr);
          return err("Messages purged but storage purge failed", 500);
        }
        deletedStorage = typeof ds === "number" ? ds : Number(ds);
      }

      return json({
        ok: true,
        days,
        deleted_messages: deletedMessages,
        ...(deletedStorage !== null ? { deleted_storage_objects: deletedStorage } : {}),
      });
    }

    // B3: 客户端直传 Storage —— 由 Edge 仅返回签名/路径，文件字节不再经 Edge。
    if (route === "/upload/sign" && req.method === "POST") {
      if (!userId) {
        return err("Unauthorized: sign in and send Authorization: Bearer <access_token>", 401);
      }
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return err("Invalid JSON");

      const channelId = String(body.channel_id || "").trim();
      const kind = String(body.kind || "").trim() as "image" | "voice" | "video";
      const rawExt = String(body.ext || "").toLowerCase();
      const ext = rawExt.replace(/[^a-z0-9]/g, "").slice(0, 8) || (
        kind === "image" ? "jpg" : kind === "voice" ? "webm" : "mp4"
      );

      if (!channelId) return err("Missing channel_id");
      if (!["image", "voice", "video"].includes(kind)) return err("Invalid kind");

      const admin = adminClient();
      if (!(await canMutateChannel(admin, channelId, userId))) {
        return err("Forbidden: not a participant of this channel", 403);
      }

      const signRl = await enforceUploadSignRateLimit(admin, userId);
      if (!signRl.ok) {
        return json(
          { error: "CHAT_RATE_LIMIT", retry_after_seconds: signRl.retryAfter },
          429,
        );
      }

      const objectPath =
        `${channelId.replace(/[^a-zA-Z0-9_-]/g, "_")}/${crypto.randomUUID()}.${ext}`;

      const { data: signed, error: signErr } = await admin.storage
        .from("chat-media")
        .createSignedUploadUrl(objectPath);
      if (signErr || !signed) {
        console.error("[chat-supabase] createSignedUploadUrl", signErr);
        return err("Sign failed", 500);
      }

      const { error: rlInsErr } = await admin.from("chat_rl_upload_sign").insert({
        user_id: userId,
      });
      if (rlInsErr) {
        console.warn("[chat-supabase] chat_rl_upload_sign insert", rlInsErr);
      }

      const { data: pub } = admin.storage.from("chat-media").getPublicUrl(objectPath);

      return json({
        uploadUrl: signed.signedUrl,
        token: signed.token,
        objectPath,
        publicUrl: pub.publicUrl,
        kind,
        maxBytes: kind === "image" ? MAX_IMAGE : kind === "voice" ? MAX_VOICE : MAX_VIDEO,
      });
    }

    if (route === "/upload" && req.method === "POST") {
      if (!userId) {
        return err("Unauthorized: sign in and send Authorization: Bearer <access_token>", 401);
      }

      const ct = req.headers.get("content-type") || "";
      if (!ct.includes("multipart/form-data")) {
        return err("Expected multipart/form-data");
      }

      const form = await req.formData();
      const file = form.get("file");
      const channelId = String(form.get("channel_id") || "").trim();
      const kind = String(form.get("kind") || "").trim() as
        | "image"
        | "voice"
        | "video";

      if (!channelId) return err("Missing channel_id");
      if (!["image", "voice", "video"].includes(kind)) return err("Invalid kind");
      if (!(file instanceof File)) return err("Missing file");

      const admin = adminClient();
      if (!(await canMutateChannel(admin, channelId, userId))) {
        return err("Forbidden: not a participant of this channel", 403);
      }

      const legacyRl = await enforceUploadSignRateLimit(admin, userId);
      if (!legacyRl.ok) {
        return json(
          { error: "CHAT_RATE_LIMIT", retry_after_seconds: legacyRl.retryAfter },
          429,
        );
      }

      const size = file.size;
      const max = kind === "image"
        ? MAX_IMAGE
        : kind === "voice"
        ? MAX_VOICE
        : MAX_VIDEO;
      if (size > max) return err(`File too large (max ${max} bytes)`);

      const ext = (() => {
        const n = file.name || "";
        const dot = n.lastIndexOf(".");
        if (dot >= 0) return n.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
        const mt = file.type;
        if (mt.includes("jpeg")) return "jpg";
        if (mt.includes("png")) return "png";
        if (mt.includes("webp")) return "webp";
        if (mt.includes("webm")) return "webm";
        if (mt.includes("mp4")) return "mp4";
        if (mt.includes("quicktime")) return "mov";
        return "bin";
      })();

      const objectPath =
        `${channelId.replace(/[^a-zA-Z0-9_-]/g, "_")}/${crypto.randomUUID()}.${ext}`;

      const buf = new Uint8Array(await file.arrayBuffer());
      const { error: upErr } = await admin.storage
        .from("chat-media")
        .upload(objectPath, buf, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

      if (upErr) {
        console.error("[chat-supabase] storage upload", upErr);
        return err("Upload failed", 500);
      }

      const { error: legRlIns } = await admin.from("chat_rl_upload_sign").insert({
        user_id: userId,
      });
      if (legRlIns) console.warn("[chat-supabase] chat_rl_upload_sign insert (legacy upload)", legRlIns);

      const { data: pub } = admin.storage.from("chat-media").getPublicUrl(objectPath);
      return json({ url: pub.publicUrl, path: objectPath });
    }

    return err(`Not found: ${route}`, 404);
  } catch (e: unknown) {
    console.error("[chat-supabase]", e);
    return err((e as Error).message || "Internal error", 500);
  }
});
