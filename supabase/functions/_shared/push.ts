// ============================================================================
// _shared/push.ts — 共享 Web Push (VAPID) + FCM HTTP v1 分发模块
// ============================================================================
// 用途：chat-supabase 写库成功后内联调用 dispatchPushFromChat，完成离线推送。
//   - PWA 端走 Web Push（VAPID）；原生 App 端走 FCM HTTP v1；国内走 JPush；
//   - 客户端订阅走 server 的 POST /push/subscribe，将 endpoint/token 落库到
//     push_subscriptions（见 001_init.sql §2 与 §4）；
//   - 需要新增 provider（如 APNs / OPPO / VIVO）时，直接在本文件扩展分支即可。
//
// 环境变量（挂在 chat-supabase / server Function 上）：
//   Web Push  : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
//   FCM v1    : FCM_SERVICE_ACCOUNT_JSON（project_id 从 JSON 中自动提取）
//   JPush     : JPUSH_APP_KEY, JPUSH_MASTER_SECRET, JPUSH_APNS_PRODUCTION（可选）
// ============================================================================

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.49.8";
import webpush from "npm:web-push@3.6.7";
import { SignJWT, importPKCS8 } from "npm:jose@5.9.6";

export interface ChatPushPayload {
  channelId: string;
  senderId: string;
  msgType: string;
  preview: string;
  at: string;
}

export interface DispatchResult {
  recipients: number;
  sent: number;
  errors: string[];
}

let _vapidConfigured: boolean | null = null;

export function configureWebPushOnce(): boolean {
  if (_vapidConfigured !== null) return _vapidConfigured;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  const priv = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
  const contact = (Deno.env.get("VAPID_CONTACT_EMAIL") || "mailto:push@localhost").trim();
  if (!pub || !priv) {
    console.warn("[shared/push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing");
    _vapidConfigured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(contact, pub, priv);
    _vapidConfigured = true;
    return true;
  } catch (e) {
    console.warn("[shared/push] setVapidDetails failed", e);
    _vapidConfigured = false;
    return false;
  }
}

let _gcpToken: { token: string; exp: number } | null = null;

async function getGoogleAccessToken(sa: {
  client_email: string;
  private_key: string;
}): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (_gcpToken && _gcpToken.exp - 60 > now) return _gcpToken.token;

  const pk = sa.private_key.replace(/\\n/g, "\n");
  const key = await importPKCS8(pk, "RS256");
  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    console.error("[shared/push] oauth token failed", data);
    return null;
  }
  _gcpToken = { token: data.access_token as string, exp: now + 3500 };
  return _gcpToken.token;
}

/**
 * FCM HTTP v1 发送结果。stale=true 表示该 token 已不可达（UNREGISTERED / INVALID_ARGUMENT /
 * SENDER_ID_MISMATCH），调用方应当从 push_subscriptions 中删除对应行。
 */
interface FcmSendResult {
  ok: boolean;
  stale: boolean;
}

export async function sendFcmV1(
  token: string,
  title: string,
  bodyText: string,
  data: Record<string, string>,
): Promise<FcmSendResult> {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON")?.trim();
  if (!raw) return { ok: false, stale: false };
  let sa: { client_email: string; private_key: string; project_id: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    console.error("[shared/push] FCM_SERVICE_ACCOUNT_JSON invalid JSON");
    return { ok: false, stale: false };
  }
  const access = await getGoogleAccessToken(sa);
  if (!access) return { ok: false, stale: false };

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body: bodyText },
        data,
      },
    }),
  });
  if (res.ok) return { ok: true, stale: false };

  const text = await res.text().catch(() => "");
  console.warn("[shared/push] FCM send failed", res.status, text);

  // FCM v1 失败体示例:
  //   {"error":{"code":404,"status":"NOT_FOUND",
  //     "details":[{"errorCode":"UNREGISTERED","@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError"}]}}
  //   {"error":{"code":400,"status":"INVALID_ARGUMENT",
  //     "details":[{"errorCode":"INVALID_ARGUMENT"}]}}
  // 这些都表示 token 无效，应清理订阅行；其他错误（5xx、配额等）保留重试机会。
  let stale = false;
  if (res.status === 404 || res.status === 400) {
    stale = true;
  } else {
    try {
      const body = JSON.parse(text) as {
        error?: {
          status?: string;
          details?: Array<{ errorCode?: string }>;
        };
      };
      const details = body?.error?.details || [];
      for (const d of details) {
        const code = d?.errorCode || "";
        if (
          code === "UNREGISTERED" ||
          code === "INVALID_ARGUMENT" ||
          code === "SENDER_ID_MISMATCH"
        ) {
          stale = true;
          break;
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return { ok: false, stale };
}

/**
 * JPush (极光推送) REST API v3 发送结果。
 * stale=true 表示该 registration_id 已不可达（错误码 1011），
 * 调用方应当从 push_subscriptions 中删除对应行。
 */
interface JpushSendResult {
  ok: boolean;
  stale: boolean;
}

export async function sendJpush(
  regId: string,
  title: string,
  bodyText: string,
  data: Record<string, string>,
): Promise<JpushSendResult> {
  const appKey = (Deno.env.get("JPUSH_APP_KEY") || "").trim();
  const masterSecret = (Deno.env.get("JPUSH_MASTER_SECRET") || "").trim();
  if (!appKey || !masterSecret) {
    return { ok: false, stale: false };
  }

  const auth = btoa(`${appKey}:${masterSecret}`);
  const payload = {
    platform: ["android", "ios"],
    audience: { registration_id: [regId] },
    notification: {
      alert: bodyText,
      android: { title, alert: bodyText },
      ios: {
        alert: { title, body: bodyText },
        sound: "default",
        badge: "+1",
      },
    },
    options: {
      apns_production: Deno.env.get("JPUSH_APNS_PRODUCTION") !== "false",
      time_to_live: 86400,
    },
  };

  try {
    const res = await fetch("https://api.jpush.cn/v3/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return { ok: true, stale: false };

    const text = await res.text().catch(() => "");
    console.warn("[shared/push] JPush send failed", res.status, text);

    // Detect stale registration: 1011 = registration_id not exist
    let stale = false;
    try {
      const body = JSON.parse(text) as { error?: { code?: number } };
      if (body?.error?.code === 1011) stale = true;
    } catch {
      /* ignore parse errors */
    }
    return { ok: false, stale };
  } catch (e) {
    console.error("[shared/push] JPush request error", e);
    return { ok: false, stale: false };
  }
}

// ─── i18n for push titles & media placeholders ─────────────────────────────
// 键严格匹配 src/app/hooks/useLanguage.tsx 的 Language 类型；扩展新语言时两处同步。
// 未知 / NULL 语言走英文兜底。
interface PushStrings {
  title: string;
  image: string;
  voice: string;
  video: string;
  fallback: string; // msg_type 未识别时使用
}

const PUSH_I18N: Record<string, PushStrings> = {
  en: { title: "New message", image: "[Image]", voice: "[Voice]", video: "[Video]", fallback: "[Message]" },
  zh: { title: "新消息", image: "[图片]", voice: "[语音]", video: "[视频]", fallback: "[消息]" },
  "zh-TW": { title: "新訊息", image: "[圖片]", voice: "[語音]", video: "[影片]", fallback: "[訊息]" },
  es: { title: "Nuevo mensaje", image: "[Imagen]", voice: "[Voz]", video: "[Video]", fallback: "[Mensaje]" },
  fr: { title: "Nouveau message", image: "[Image]", voice: "[Audio]", video: "[Vidéo]", fallback: "[Message]" },
  ar: { title: "رسالة جديدة", image: "[صورة]", voice: "[صوت]", video: "[فيديو]", fallback: "[رسالة]" },
  pt: { title: "Nova mensagem", image: "[Imagem]", voice: "[Voz]", video: "[Vídeo]", fallback: "[Mensagem]" },
  hi: { title: "नया संदेश", image: "[चित्र]", voice: "[आवाज़]", video: "[वीडियो]", fallback: "[संदेश]" },
  ru: { title: "Новое сообщение", image: "[Изображение]", voice: "[Голос]", video: "[Видео]", fallback: "[Сообщение]" },
  bn: { title: "নতুন বার্তা", image: "[ছবি]", voice: "[ভয়েস]", video: "[ভিডিও]", fallback: "[বার্তা]" },
  ur: { title: "نیا پیغام", image: "[تصویر]", voice: "[آواز]", video: "[ویڈیو]", fallback: "[پیغام]" },
  id: { title: "Pesan baru", image: "[Gambar]", voice: "[Suara]", video: "[Video]", fallback: "[Pesan]" },
  vi: { title: "Tin nhắn mới", image: "[Hình ảnh]", voice: "[Giọng nói]", video: "[Video]", fallback: "[Tin nhắn]" },
  ms: { title: "Mesej baru", image: "[Gambar]", voice: "[Suara]", video: "[Video]", fallback: "[Mesej]" },
  ja: { title: "新着メッセージ", image: "[画像]", voice: "[音声]", video: "[動画]", fallback: "[メッセージ]" },
  th: { title: "ข้อความใหม่", image: "[รูปภาพ]", voice: "[เสียง]", video: "[วิดีโอ]", fallback: "[ข้อความ]" },
  my: { title: "မက်ဆေ့ချ် အသစ်", image: "[ပုံ]", voice: "[အသံ]", video: "[ဗီဒီယို]", fallback: "[မက်ဆေ့ချ်]" },
  tl: { title: "Bagong mensahe", image: "[Larawan]", voice: "[Boses]", video: "[Video]", fallback: "[Mensahe]" },
  tr: { title: "Yeni mesaj", image: "[Resim]", voice: "[Ses]", video: "[Video]", fallback: "[Mesaj]" },
  fa: { title: "پیام جدید", image: "[تصویر]", voice: "[صدا]", video: "[ویدیو]", fallback: "[پیام]" },
};

export function pickStrings(language: string | null | undefined): PushStrings {
  const raw = (language || "").trim();
  if (!raw) return PUSH_I18N.en;
  if (PUSH_I18N[raw]) return PUSH_I18N[raw];
  // 按 BCP-47 截取 primary subtag：如 "en-US" → "en"；"zh-Hans-CN" 不匹配时先看 "zh-Hans" → "zh"。
  const parts = raw.split("-");
  for (let i = parts.length - 1; i > 0; i--) {
    const slice = parts.slice(0, i).join("-");
    if (PUSH_I18N[slice]) return PUSH_I18N[slice];
  }
  return PUSH_I18N.en;
}

function buildLocalizedBody(
  strings: PushStrings,
  msgType: string,
  preview: string,
): string {
  const trimmed = preview.trim();
  if (trimmed) return trimmed;
  switch (msgType) {
    case "image":
      return strings.image;
    case "voice":
      return strings.voice;
    case "video":
      return strings.video;
    default:
      return strings.fallback;
  }
}

async function resolveRecipientUserIds(
  admin: SupabaseClient,
  channelId: string,
  senderId: string,
): Promise<string[]> {
  const ids = new Set<string>();

  const { data: msgRows } = await admin
    .from("chat_messages")
    .select("sender_id")
    .eq("channel_id", channelId);
  for (const r of msgRows || []) {
    const sid = String((r as { sender_id?: string }).sender_id || "");
    if (sid && sid !== senderId) ids.add(sid);
  }

  const { data: mfc } = await admin
    .from("merchant_farmer_channels")
    .select("farmer_user_id, merchant_user_id")
    .eq("channel_id", channelId)
    .maybeSingle();
  const farmer = mfc?.farmer_user_id ? String(mfc.farmer_user_id) : "";
  const merchant = mfc?.merchant_user_id ? String(mfc.merchant_user_id) : "";
  if (farmer && farmer !== senderId) ids.add(farmer);
  if (merchant && merchant !== senderId) ids.add(merchant);

  return [...ids];
}

/**
 * chat-supabase 写库成功后调用：解析收件人 → 分发 webpush + FCM。
 * 返回的 promise 应通过 EdgeRuntime.waitUntil 托管，主请求不必 await 它。
 * 不抛异常；个别推送失败仅日志记录，并清理 410/404 失效订阅。
 */
export async function dispatchPushFromChat(
  admin: SupabaseClient,
  payload: ChatPushPayload,
): Promise<DispatchResult> {
  const { channelId, senderId, msgType, preview } = payload;
  const result: DispatchResult = { recipients: 0, sent: 0, errors: [] };

  const recipients = await resolveRecipientUserIds(admin, channelId, senderId);
  result.recipients = recipients.length;
  if (recipients.length === 0) return result;

  const data = {
    channel_id: channelId,
    sender_id: senderId,
    msg_type: msgType,
    route: "/home/community",
  };
  const webOk = configureWebPushOnce();

  for (const uid of recipients) {
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, platform, endpoint, p256dh, auth, fcm_token, language")
      .eq("user_id", uid);

    for (const row of subs || []) {
      const platform = String((row as { platform?: string }).platform || "webpush");
      const rowId = (row as { id: string }).id;
      const language = (row as { language?: string | null }).language ?? null;
      const strings = pickStrings(language);
      const title = strings.title;
      const bodyText = buildLocalizedBody(strings, msgType, preview);

      if (platform === "fcm") {
        const tok = (row as { fcm_token?: string }).fcm_token;
        if (!tok) continue;
        try {
          const sendRes = await sendFcmV1(tok, title, bodyText, data);
          if (sendRes.ok) {
            result.sent += 1;
          } else if (sendRes.stale) {
            await admin.from("push_subscriptions").delete().eq("id", rowId);
            result.errors.push(`fcm:${uid}: stale token removed`);
          }
        } catch (e) {
          result.errors.push(`fcm:${uid}: ${(e as Error).message}`);
        }
        continue;
      }

      if (platform === "jpush") {
        const regId = (row as { fcm_token?: string }).fcm_token;
        if (!regId) continue;
        try {
          const sendRes = await sendJpush(regId, title, bodyText, data);
          if (sendRes.ok) {
            result.sent += 1;
          } else if (sendRes.stale) {
            await admin.from("push_subscriptions").delete().eq("id", rowId);
            result.errors.push(`jpush:${uid}: stale token removed`);
          }
        } catch (e) {
          result.errors.push(`jpush:${uid}: ${(e as Error).message}`);
        }
        continue;
      }

      if (platform === "webpush" && webOk) {
        const endpoint = (row as { endpoint?: string }).endpoint;
        const p256dh = (row as { p256dh?: string }).p256dh;
        const auth = (row as { auth?: string }).auth;
        if (!endpoint || !p256dh || !auth) continue;

        const subscription = { endpoint, keys: { p256dh, auth } };
        try {
          await webpush.sendNotification(
            subscription as unknown as webpush.PushSubscription,
            JSON.stringify({
              title,
              body: bodyText,
              channel_id: channelId,
              data: { url: "/home/community", channel_id: channelId },
            }),
            { TTL: 86400 },
          );
          result.sent += 1;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`web:${uid}: ${msg}`);
          const statusCode = (e as { statusCode?: number })?.statusCode;
          if (statusCode === 410 || statusCode === 404) {
            await admin.from("push_subscriptions").delete().eq("id", rowId);
          }
        }
      }
    }
  }

  return result;
}

// Re-export webpush for direct use by server/index.tsx (POST /push/send)
export { webpush };
