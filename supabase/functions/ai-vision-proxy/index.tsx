// ============================================================================
// ai-vision-proxy — Cloud AI Vision Analysis Edge Function
// ============================================================================
//
// Proxies image analysis requests to cloud AI providers.
// The frontend NEVER touches API keys — all credentials are server-side secrets.
//
// Endpoints:
//   POST /ai-vision-proxy     — Analyze image / follow-up / voice follow-up
//   GET  /ai-vision-proxy/health — Health check
//
// Supported AI Providers:
//   - qwen       → Alibaba DashScope (qwen-vl series)
//   - gemini     → Google Gemini (gemini-2.0-flash etc.)
//   - openai     → OpenAI-compatible (GPT-4o, etc.)
//
// Request Types (determined by body fields):
//   1. Image analysis:   { image, detections, modelId, maxTokens, uiLanguage? } — system prompt from app_config (cached), not client body
//   2. Text follow-up:   { followUp: true, userMessage, previousAnalysis, ... }
//   2b. Image follow-up: { followUp: true, image, userMessage, previousAnalysis, ... }
//   3. Voice follow-up:  { voiceFollowUp: true, audio, previousAnalysis, ... }
//   Dev only: ALLOW_CLIENT_SYSTEM_PROMPT=true allows body.systemPrompt to override DB.
//      uiLanguage: app locale (e.g. en, zh, zh-TW) — reply must match; sanitized server-side.
//
// Response (normalized):
//   { analysis, provider, model, confidence?, suggestions?, transcription? }
//
// Environment Variables (Supabase Dashboard > Edge Functions > Secrets):
//   AI_PROVIDER    — Provider name: qwen | gemini | openai  (default: qwen)
//   AI_API_KEY     — API key for the selected provider
//   AI_BASE_URL    — (Optional) Custom API base URL (for self-hosted / proxy)
//   AI_MODEL_ID    — (Optional) Default model ID override
//
// Rate limits — optional overrides if app_config.cloudAIConfig is missing a field:
//   AI_RL_INTERVAL_SEC   — Min seconds between AI calls (default: 10)
//   AI_RL_DAILY_LIMIT    — Max calls per user per day (default: 30)
//   AI_RL_WINDOW_PER_MIN — Max calls per user per rolling minute (default: 6)
// Primary source: app_config (id=main).config.cloudAIConfig — see getAppConfigCloudCache().
//
// ============================================================================

// ---- Imports ----

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.49.8";

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
  void p.catch((e) => console.warn("[ai-vision-proxy] background task error", e));
}

// ---- CORS ----

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errResp(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** App locale from client (BCP-47 subset); rejects junk / prompt injection. */
function sanitizeUiLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, 24);
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/.test(s)) return null;
  return s;
}

/** Append instruction so model replies in the same language as the app UI. */
function applyUiLanguageToSystemPrompt(systemMsg: string, uiLanguage: unknown): string {
  const lang = sanitizeUiLanguage(uiLanguage);
  if (!lang) return systemMsg;
  const hint =
    `\n\n[UI language — required] The farmer is using the app in locale "${lang}". ` +
    `Write your entire reply in that language (all headings, lists, and body). ` +
    `Examples: en → English; zh → Simplified Chinese; zh-TW → Traditional Chinese. ` +
    `This overrides any earlier one-line instruction to use only Chinese or only English.`;
  return systemMsg + hint;
}

function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function blurGpsCoordinate(n: number): number {
  return Math.round(n * 100) / 100;
}

function applyLocationContextToSystemPrompt(systemMsg: string, body: any): string {
  let extra = "";
  const loc = body?.locationContext;
  if (loc && isValidLatLng(loc.latitude, loc.longitude)) {
    const lat = blurGpsCoordinate(loc.latitude);
    const lng = blurGpsCoordinate(loc.longitude);
    extra +=
      `\n\nFarmer approximate location (GPS): lat ${lat}, lng ${lng}`;
    if (typeof loc.accuracyMeters === "number" && Number.isFinite(loc.accuracyMeters)) {
      extra += `, accuracy ${loc.accuracyMeters}m`;
    }
    extra +=
      ". Use for regional pest/disease and climate context when relevant.";
  }
  return extra ? systemMsg + extra : systemMsg;
}

// ---- Route ----

function getRoute(req: Request): string {
  const url = new URL(req.url);
  return url.pathname.replace(/^\/ai-vision-proxy/, "") || "/";
}

// ---- Config ----

type AIProvider = "qwen" | "gemini" | "openai";

interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

function getAIConfig(requestModelId?: string): AIConfig {
  const provider = (Deno.env.get("AI_PROVIDER") || "qwen") as AIProvider;
  const apiKey = Deno.env.get("AI_API_KEY") || "";

  // Default base URLs per provider
  const defaultBaseUrls: Record<AIProvider, string> = {
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    openai: "https://api.openai.com/v1",
  };

  // Default model IDs per provider
  const defaultModels: Record<AIProvider, string> = {
    qwen: "qwen-vl-plus",
    gemini: "gemini-2.0-flash",
    openai: "gpt-4o",
  };

  return {
    provider,
    apiKey,
    baseUrl: Deno.env.get("AI_BASE_URL") || defaultBaseUrls[provider] || defaultBaseUrls.qwen,
    modelId: Deno.env.get("AI_MODEL_ID") || requestModelId || defaultModels[provider] || "qwen-vl-plus",
  };
}

// ---- Auth & Rate-limit helpers ----
//
// 服务端防刷四层（与 migrations/001_init.sql §3a 对齐）：
//   1) verify_jwt（Supabase Gateway，见 supabase/config.toml）
//   2) extractUserJwt + getAuthUserId：函数内再校验一次，强制登录
//   3) enforceRateLimit：最小间隔 + 每日配额（RPC 原子） + 滑动窗口（ai_usage COUNT）
//   4) Cloudflare IP 级 Rate Limiting（运维配置，见 DEPLOY_GUIDE_CN.md）

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

/** 从 Authorization 取出用户 JWT；拒绝把 anon key 当作用户 token */
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
  try {
    const client = bearerUserClient(jwt);
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user?.id) return null;
    return data.user.id;
  } catch (e) {
    console.warn("[ai-vision-proxy] getAuthUserId failed", e);
    return null;
  }
}

const APP_CONFIG_CLOUD_TTL_MS = 45_000;

type AppConfigCloudState = {
  at: number;
  systemPrompt: string;
  intervalSec: number;
  dailyLimit: number;
  windowPerMin: number;
  maxConcurrent: number;
  allowUnauthenticatedUse: boolean;
};

const AI_QUEUE_MAX_CAP = 100;
const AI_QUEUE_MIN_CONCURRENT = 5;

function clampQueueMax(n: number): number {
  return Math.min(AI_QUEUE_MAX_CAP, Math.max(AI_QUEUE_MIN_CONCURRENT, Math.floor(n)));
}

function envQueueDefaults(): { maxConcurrent: number; leaseSec: number; retrySec: number } {
  return {
    maxConcurrent: clampQueueMax(envInt("AI_QUEUE_MAX_CONCURRENT", 100)),
    leaseSec: Math.min(300, Math.max(30, envInt("AI_QUEUE_LEASE_SEC", 120))),
    retrySec: Math.min(30, Math.max(3, envInt("AI_QUEUE_RETRY_SEC", 8))),
  };
}

type QueueLeaseResult =
  | { ok: true; leaseId: string }
  | { ok: false; retryAfter: number; queueDepth?: number };

function routeHintFromBody(body: Record<string, unknown>): string {
  if (body.voiceFollowUp) return "voice";
  if (body.followUp && body.image) return "follow_up_image";
  if (body.followUp) return "follow_up_text";
  return "analysis";
}

async function tryAcquireQueue(
  admin: SupabaseClient,
  userId: string | null,
  route: string,
  cloudCfg: AppConfigCloudState,
): Promise<QueueLeaseResult> {
  const q = envQueueDefaults();
  const maxConcurrent = cloudCfg.maxConcurrent ?? q.maxConcurrent;
  const leaseSec = q.leaseSec;
  try {
    const { data, error } = await admin.rpc("ai_queue_try_acquire", {
      p_max: maxConcurrent,
      p_lease_sec: leaseSec,
      p_user_id: userId,
      p_route: route,
    });
    if (error) {
      console.error("[ai-vision-proxy] ai_queue_try_acquire error:", error);
      return { ok: true, leaseId: "" };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.status === "OK" && row?.lease_id) {
      return { ok: true, leaseId: String(row.lease_id) };
    }
    const retryAfter = Number(row?.retry_after_seconds);
    return {
      ok: false,
      retryAfter: Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : q.retrySec,
      queueDepth: typeof row?.queue_depth === "number" ? row.queue_depth : undefined,
    };
  } catch (e) {
    console.warn("[ai-vision-proxy] ai_queue_try_acquire exception:", e);
    return { ok: true, leaseId: "" };
  }
}

async function releaseQueue(admin: SupabaseClient, leaseId: string): Promise<void> {
  if (!leaseId) return;
  try {
    const { error } = await admin.rpc("ai_queue_release", { p_lease_id: leaseId });
    if (error) console.warn("[ai-vision-proxy] ai_queue_release failed", error);
  } catch (e) {
    console.warn("[ai-vision-proxy] ai_queue_release exception:", e);
  }
}

let appConfigCloudCache: AppConfigCloudState | null = null;

function envRateDefaults(): { intervalSec: number; dailyLimit: number; windowPerMin: number } {
  return {
    intervalSec: envInt("AI_RL_INTERVAL_SEC", 10),
    dailyLimit: envInt("AI_RL_DAILY_LIMIT", 30),
    windowPerMin: envInt("AI_RL_WINDOW_PER_MIN", 6),
  };
}

/**
 * One app_config read for systemPrompt + rate limits (short TTL), merged with
 * env fallbacks. cloudAIConfig.clientCooldownSeconds / clientDailyLimit / clientWindowPerMin
 * override env when set (>= 1); otherwise env (or built-in default) is used.
 */
async function getAppConfigCloudCache(admin: SupabaseClient): Promise<AppConfigCloudState> {
  const now = Date.now();
  if (appConfigCloudCache && now - appConfigCloudCache.at < APP_CONFIG_CLOUD_TTL_MS) {
    return appConfigCloudCache;
  }
  const fb = envRateDefaults();
  const qd = envQueueDefaults();
  let systemPrompt = "";
  let intervalSec = fb.intervalSec;
  let dailyLimit = fb.dailyLimit;
  let windowPerMin = fb.windowPerMin;
  let maxConcurrent = qd.maxConcurrent;
  let allowUnauthenticatedUse = false;
  try {
    const { data, error } = await admin
      .from("app_config")
      .select("config")
      .eq("id", "main")
      .maybeSingle();
    if (!error && data?.config && typeof data.config === "object") {
      const cfg = data.config as Record<string, unknown>;
      const cloud = cfg.cloudAIConfig;
      if (cloud && typeof cloud === "object" && !Array.isArray(cloud)) {
        const c = cloud as Record<string, unknown>;
        if (typeof c.systemPrompt === "string" && c.systemPrompt.trim()) {
          systemPrompt = c.systemPrompt.trim();
        }
        if (c.allowUnauthenticatedUse === true) {
          allowUnauthenticatedUse = true;
        }
        const cs = c.clientCooldownSeconds;
        if (typeof cs === "number" && Number.isFinite(cs) && cs >= 1) {
          intervalSec = Math.min(3600, Math.max(1, Math.floor(cs)));
        }
        const dl = c.clientDailyLimit;
        if (typeof dl === "number" && Number.isFinite(dl) && dl >= 1) {
          dailyLimit = Math.min(10000, Math.max(1, Math.floor(dl)));
        }
        const wm = c.clientWindowPerMin;
        if (typeof wm === "number" && Number.isFinite(wm) && wm >= 1) {
          windowPerMin = Math.min(200, Math.max(1, Math.floor(wm)));
        }
        const mc = c.clientMaxConcurrent;
        if (typeof mc === "number" && Number.isFinite(mc) && mc >= 1) {
          maxConcurrent = clampQueueMax(mc);
        }
      }
    }
  } catch (e) {
    console.warn("[ai-vision-proxy] getAppConfigCloudCache failed", e);
  }
  appConfigCloudCache = {
    at: now,
    systemPrompt,
    intervalSec,
    dailyLimit,
    windowPerMin,
    maxConcurrent,
    allowUnauthenticatedUse,
  };
  return appConfigCloudCache;
}

/** Load cloudAIConfig.systemPrompt from app_config (shared TTL cache). */
async function getAppConfigSystemPrompt(): Promise<string> {
  try {
    const c = await getAppConfigCloudCache(adminClient());
    return c.systemPrompt;
  } catch (e) {
    console.warn("[ai-vision-proxy] getAppConfigSystemPrompt failed", e);
    return "";
  }
}

function pickSystemPrompt(
  bodyPrompt: unknown,
  dbPrompt: string,
  fallback: string,
): string {
  if (Deno.env.get("ALLOW_CLIENT_SYSTEM_PROMPT") === "true") {
    if (typeof bodyPrompt === "string" && bodyPrompt.trim()) {
      return bodyPrompt.trim();
    }
  }
  const d = (dbPrompt || "").trim();
  if (d) return d;
  const envP = (Deno.env.get("AI_DEFAULT_SYSTEM_PROMPT") || "").trim();
  if (envP) return envP;
  return fallback;
}

function getClientIp(req: Request): string {
  const raw =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for") ||
    "";
  return raw.split(",")[0].trim();
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(Deno.env.get(key) || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

type RateLimitGate =
  | { ok: true }
  | { ok: false; code: "INTERVAL" | "DAILY" | "WINDOW"; retryAfter?: number };

/**
 * 服务端限流闸门：
 *   - RPC ai_rate_limit_check 原子更新 last_ai_call + ai_calls_today
 *     （避免并发双点）。INTERVAL/DAILY 直接返回。
 *   - 滑动窗口：COUNT(ai_usage WHERE user_id=? AND created_at > now() - 1 min)
 *     >= WINDOW 时返回 WINDOW。
 *
 * 注意：RPC 在 OK 分支里已经把 last_ai_call/ai_calls_today 写入了，所以即便
 * 下游 AI 调用失败，本次也会"计入配额"——这是故意的，防止脚本借失败反复重试。
 */
async function enforceRateLimit(
  admin: SupabaseClient,
  userId: string,
): Promise<RateLimitGate> {
  const limits = await getAppConfigCloudCache(admin);
  const { intervalSec, dailyLimit, windowPerMin } = limits;

  // 1. RPC: INTERVAL + DAILY（原子）
  const { data, error } = await admin.rpc("ai_rate_limit_check", {
    p_user_id: userId,
    p_interval_sec: intervalSec,
    p_daily_limit: dailyLimit,
  });

  if (error) {
    // RPC 失败时保守放行并记录，避免一张表挂掉就全面不可用
    console.error("[ai-vision-proxy] ai_rate_limit_check error:", error);
    return { ok: true };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (row?.status === "INTERVAL") {
    return { ok: false, code: "INTERVAL", retryAfter: row.retry_after_seconds ?? intervalSec };
  }
  if (row?.status === "DAILY") {
    return { ok: false, code: "DAILY" };
  }

  // 2. 滑动窗口
  try {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count, error: cntErr } = await admin
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gt("created_at", since);

    if (cntErr) {
      console.warn("[ai-vision-proxy] ai_usage count error:", cntErr);
      return { ok: true };
    }
    if ((count ?? 0) >= windowPerMin) {
      return { ok: false, code: "WINDOW", retryAfter: 60 };
    }
  } catch (e) {
    console.warn("[ai-vision-proxy] ai_usage count exception:", e);
  }

  return { ok: true };
}

/** In-memory guest (IP) rate limit — per Edge isolate; pair with Cloudflare IP limiting in prod */
const guestIpCalls = new Map<string, number[]>();

function pruneGuestTimestamps(calls: number[], now: number): number[] {
  const dayAgo = now - 86_400_000;
  return calls.filter((t) => t > dayAgo).slice(-500);
}

function enforceGuestRateLimit(
  ip: string,
  limits: { intervalSec: number; dailyLimit: number; windowPerMin: number },
): RateLimitGate {
  const key = ip || "unknown";
  const now = Date.now();
  const prev = guestIpCalls.get(key) ?? [];
  const calls = pruneGuestTimestamps(prev, now);

  if (calls.length >= limits.dailyLimit) {
    return { ok: false, code: "DAILY" };
  }

  const last = calls.length ? calls[calls.length - 1] : 0;
  if (last && now - last < limits.intervalSec * 1000) {
    return { ok: false, code: "INTERVAL", retryAfter: limits.intervalSec };
  }

  const minAgo = now - 60_000;
  const inWindow = calls.filter((t) => t > minAgo).length;
  if (inWindow >= limits.windowPerMin) {
    return { ok: false, code: "WINDOW", retryAfter: 60 };
  }

  calls.push(now);
  guestIpCalls.set(key, calls);
  return { ok: true };
}

/** 成功调用 AI 后异步记录一行 ai_usage（滑动窗口依据） */
function recordAiUsage(
  admin: SupabaseClient,
  userId: string,
  route: string,
  provider: string,
  ip: string,
): void {
  waitUntil(
    admin
      .from("ai_usage")
      .insert({ user_id: userId, route, provider, ip })
      .then(({ error }) => {
        if (error) console.warn("[ai-vision-proxy] insert ai_usage failed", error);
      }),
  );
}

// ---- Main Handler ----

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const route = getRoute(req);
  const method = req.method;

  try {
    // GET /health — 不鉴权，便于探活
    if (route === "/health" && method === "GET") {
      const cfg = getAIConfig();
      return json({
        status: "ok",
        timestamp: new Date().toISOString(),
        provider: cfg.provider,
        modelId: cfg.modelId,
        configured: !!cfg.apiKey,
      });
    }

    // POST / — Main analysis endpoint（鉴权 + 限流）
    if ((route === "/" || route === "") && method === "POST") {
      const admin = adminClient();
      const cloudCfg = await getAppConfigCloudCache(admin);
      const jwt = extractUserJwt(req);
      let userId: string | null = null;
      let rateKey: string;
      let isGuest = false;

      if (jwt) {
        userId = await getAuthUserId(jwt);
      }

      if (userId) {
        rateKey = userId;
      } else if (cloudCfg.allowUnauthenticatedUse) {
        isGuest = true;
        rateKey = getClientIp(req) || "unknown";
      } else {
        return errResp("unauthorized", 401);
      }

      const body = (await req.json()) as Record<string, unknown>;
      const routeHint = routeHintFromBody(body);

      const lease = await tryAcquireQueue(admin, userId, routeHint, cloudCfg);
      if (!lease.ok) {
        return json(
          {
            error: "QUEUE",
            retry_after_seconds: lease.retryAfter,
            queue_depth: lease.queueDepth ?? null,
          },
          429,
        );
      }

      try {
        const gate = isGuest
          ? enforceGuestRateLimit(rateKey, cloudCfg)
          : await enforceRateLimit(admin, userId!);
        if (!gate.ok) {
          return json(
            { error: gate.code, retry_after_seconds: gate.retryAfter ?? null },
            429,
          );
        }

        const resp = await handleAnalysis(body);

        if (resp.status >= 200 && resp.status < 300 && userId) {
          const provider = (Deno.env.get("AI_PROVIDER") || "qwen");
          const ip = getClientIp(req);
          const usageRoute = routeHint === "analysis" ? "analysis" : routeHint;
          recordAiUsage(admin, userId, usageRoute, provider, ip);
        }

        return resp;
      } finally {
        await releaseQueue(admin, lease.leaseId);
      }
    }

    return errResp(`Unknown route: ${method} ${route}`, 404);
  } catch (e: any) {
    console.error("[ai-vision-proxy] Unhandled error:", e);
    return errResp(e.message || "Internal server error", 500);
  }
});

// ============================================================================
// Analysis Handler — Routes to the correct AI provider
// ============================================================================

async function handleAnalysis(body: any): Promise<Response> {
  const cfg = getAIConfig(body.modelId);

  if (!cfg.apiKey) {
    return errResp(
      `AI provider '${cfg.provider}' not configured. Set AI_API_KEY in Edge Function secrets.`,
      500,
    );
  }

  const dbPrompt = await getAppConfigSystemPrompt();

  // Determine request type
  if (body.voiceFollowUp) {
    return await handleVoiceFollowUp(cfg, body, dbPrompt);
  }
  if (body.followUp && body.image) {
    return await handleFollowUpWithImage(cfg, body, dbPrompt);
  }
  if (body.followUp) {
    return await handleTextFollowUp(cfg, body, dbPrompt);
  }
  return await handleImageAnalysis(cfg, body, dbPrompt);
}

// ============================================================================
// 1. Image Analysis
// ============================================================================

async function handleImageAnalysis(
  cfg: AIConfig,
  body: any,
  dbPrompt: string,
): Promise<Response> {
  const { image, detections, systemPrompt, maxTokens, uiLanguage } = body;

  if (!image) {
    return errResp("Missing 'image' field (base64 image data)");
  }

  // Build context from on-device detections
  const detectionContext = (detections || [])
    .map((d: any) => `${d.className} (confidence: ${(d.score * 100).toFixed(1)}%)`)
    .join(", ");

  const defaultVision =
    "You are a professional agronomist. Your task is to identify pests and diseases from uploaded field images and provide professional management advice. " +
    "Limit responses to 300 words. Do not address non-agricultural queries. If an image is unclear, politely ask the farmer to upload a new, high-quality photo.";
  const baseSystem = pickSystemPrompt(systemPrompt, dbPrompt, defaultVision);
  const systemMsg = applyLocationContextToSystemPrompt(
    applyUiLanguageToSystemPrompt(baseSystem, uiLanguage),
    body,
  );

  const userPrompt = detectionContext
    ? `On-device model detected: ${detectionContext}. Please provide a deep analysis of this crop image, confirm or correct the detection results, and give detailed treatment recommendations.`
    : "Please analyze this crop image. Identify any diseases, pests, or nutritional issues, and provide treatment recommendations.";

  const tokenLimit = maxTokens || 1024;

  switch (cfg.provider) {
    case "qwen":
      return await callQwen(cfg, systemMsg, userPrompt, image, tokenLimit);
    case "gemini":
      return await callGemini(cfg, systemMsg, userPrompt, image, tokenLimit);
    case "openai":
      return await callOpenAI(cfg, systemMsg, userPrompt, image, tokenLimit);
    default:
      return errResp(`Unsupported provider: ${cfg.provider}`);
  }
}

// ============================================================================
// 2. Text Follow-Up
// ============================================================================

async function handleTextFollowUp(
  cfg: AIConfig,
  body: any,
  dbPrompt: string,
): Promise<Response> {
  const { userMessage, previousAnalysis, systemPrompt, maxTokens, uiLanguage } = body;

  if (!userMessage) {
    return errResp("Missing 'userMessage'");
  }

  const defaultFollow =
    "You are a professional agronomist. Continue the conversation based on the previous analysis context. " +
    "Provide specific crop management, disease treatment, or farming practice advice. " +
    "Limit responses to 300 words. Do not address non-agricultural queries.";
  const baseSystem = pickSystemPrompt(systemPrompt, dbPrompt, defaultFollow);
  const systemMsg = applyLocationContextToSystemPrompt(
    applyUiLanguageToSystemPrompt(baseSystem, uiLanguage),
    body,
  );

  const messages = buildTextMessages(systemMsg, previousAnalysis, userMessage);
  const tokenLimit = maxTokens || 1024;

  switch (cfg.provider) {
    case "qwen":
      return await callQwenText(cfg, messages, tokenLimit);
    case "gemini":
      return await callGeminiText(cfg, messages, tokenLimit);
    case "openai":
      return await callOpenAIText(cfg, messages, tokenLimit);
    default:
      return errResp(`Unsupported provider: ${cfg.provider}`);
  }
}

// ============================================================================
// 2b. Image Follow-Up (new photo in ongoing conversation)
// ============================================================================

async function handleFollowUpWithImage(
  cfg: AIConfig,
  body: any,
  dbPrompt: string,
): Promise<Response> {
  const { image, userMessage, previousAnalysis, systemPrompt, maxTokens, uiLanguage } = body;

  if (!image) {
    return errResp("Missing 'image' field (base64 image data)");
  }
  if (!userMessage) {
    return errResp("Missing 'userMessage'");
  }

  const defaultFollowImage =
    "You are a professional agronomist. The farmer sent a follow-up photo in an ongoing consultation. " +
    "Analyze the new image in light of the previous analysis and conversation. " +
    "Limit responses to 300 words. Do not address non-agricultural queries.";
  const baseSystem = pickSystemPrompt(systemPrompt, dbPrompt, defaultFollowImage);
  const systemMsg = applyLocationContextToSystemPrompt(
    applyUiLanguageToSystemPrompt(baseSystem, uiLanguage),
    body,
  );

  const contextBlock = previousAnalysis
    ? `Previous analysis and conversation:\n${previousAnalysis}\n\n`
    : "";
  const userPrompt =
    `${contextBlock}User follow-up: ${userMessage}\n\n` +
    "Please analyze this new photo and explain how it relates to the prior context.";

  const tokenLimit = maxTokens || 1024;

  switch (cfg.provider) {
    case "qwen":
      return await callQwen(cfg, systemMsg, userPrompt, image, tokenLimit);
    case "gemini":
      return await callGemini(cfg, systemMsg, userPrompt, image, tokenLimit);
    case "openai":
      return await callOpenAI(cfg, systemMsg, userPrompt, image, tokenLimit);
    default:
      return errResp(`Unsupported provider: ${cfg.provider}`);
  }
}

// ============================================================================
// 3. Voice Follow-Up (audio → STT → text → AI reply)
// ============================================================================

async function handleVoiceFollowUp(
  cfg: AIConfig,
  body: any,
  dbPrompt: string,
): Promise<Response> {
  const { audio, previousAnalysis, systemPrompt, maxTokens, uiLanguage } = body;

  if (!audio) {
    return errResp("Missing 'audio' field (base64 audio data)");
  }

  // For providers that support native audio input (Gemini, GPT-4o-audio),
  // we can send audio directly. For others, we'd need a separate STT step.
  // Currently: Gemini and OpenAI support audio natively; Qwen needs STT proxy.

  // Strategy: Extract transcription + generate reply
  // For simplicity, we use the provider's multimodal capability if available,
  // otherwise fallback to describing the audio as a text prompt.

  const defaultVoice =
    "You are a professional agronomist. The user sent a voice message about agricultural issues. " +
    "Provide professional management advice on pests, diseases, or crop management. " +
    "Limit responses to 300 words. Do not address non-agricultural queries. " +
    "If the audio is unclear, politely ask the farmer to type their question or upload a new, high-quality photo.";
  const baseSystem = pickSystemPrompt(systemPrompt, dbPrompt, defaultVoice);
  const systemMsg = applyLocationContextToSystemPrompt(
    applyUiLanguageToSystemPrompt(baseSystem, uiLanguage),
    body,
  );

  const tokenLimit = maxTokens || 1024;

  // Check if audio is base64 data URL
  const isDataUrl = audio.startsWith("data:");
  const mimeMatch = audio.match(/^data:(audio\/[^;]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : "audio/webm";
  const audioBase64 = isDataUrl ? audio.replace(/^data:[^;]+;base64,/, "") : audio;

  switch (cfg.provider) {
    case "gemini":
      // Gemini supports inline audio data
      return await callGeminiAudio(cfg, systemMsg, previousAnalysis, audioBase64, mimeType, tokenLimit);
    case "openai":
      // GPT-4o supports audio in input_audio format
      return await callOpenAIAudio(cfg, systemMsg, previousAnalysis, audioBase64, tokenLimit);
    case "qwen":
      // Qwen VL doesn't natively support audio — fallback to text
      return await callQwenText(cfg, [
        { role: "system", content: systemMsg },
        ...(previousAnalysis ? [{ role: "assistant", content: previousAnalysis }] : []),
        { role: "user", content: "[User sent a voice message. Audio transcription is not available for this provider. Please ask the user to type their question.]" },
      ], tokenLimit);
    default:
      return errResp(`Unsupported provider: ${cfg.provider}`);
  }
}

// ============================================================================
// Provider Implementations
// ============================================================================

// ---- Helper: Build text messages ----

function buildTextMessages(
  systemMsg: string,
  previousAnalysis: string | undefined,
  userMessage: string,
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemMsg },
  ];
  if (previousAnalysis) {
    messages.push({ role: "assistant", content: previousAnalysis });
  }
  messages.push({ role: "user", content: userMessage });
  return messages;
}

// ---- Helper: Extract text from AI response ----

function extractText(data: any): string {
  // Try common response formats
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  if (data.output?.text) return data.output.text;
  if (data.output?.choices?.[0]?.message?.content) return data.output.choices[0].message.content;
  if (data.candidates?.[0]?.content?.parts?.[0]?.text) return data.candidates[0].content.parts[0].text;
  if (data.text) return data.text;
  if (data.content) return data.content;
  if (typeof data === "string") return data;
  return "";
}

// ============================================================================
// Qwen / DashScope (OpenAI-compatible mode)
// ============================================================================
// Docs: https://help.aliyun.com/zh/dashscope/developer-reference/qwen-vl-plus
// Uses OpenAI-compatible endpoint: /compatible-mode/v1/chat/completions

async function callQwen(
  cfg: AIConfig,
  systemMsg: string,
  userPrompt: string,
  imageBase64: string,
  maxTokens: number,
): Promise<Response> {
  const url = `${cfg.baseUrl}/chat/completions`;

  // Clean base64 — DashScope accepts data URL format
  const imageUrl = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const payload = {
    model: cfg.modelId,
    messages: [
      { role: "system", content: systemMsg },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: userPrompt },
        ],
      },
    ],
    max_tokens: maxTokens,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][Qwen] API error ${res.status}:`, errBody);
    return errResp(`Qwen API error: ${res.status} ${errBody}`, 502);
  }

  const data = await res.json();
  const analysis = extractText(data);

  return json({
    analysis,
    provider: "通义千问",
    model: cfg.modelId,
  });
}

async function callQwenText(
  cfg: AIConfig,
  messages: { role: string; content: any }[],
  maxTokens: number,
): Promise<Response> {
  const url = `${cfg.baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.modelId.replace("-vl-", "-"), // Use text model for follow-ups
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][Qwen] Text API error ${res.status}:`, errBody);
    return errResp(`Qwen API error: ${res.status}`, 502);
  }

  const data = await res.json();
  return json({ analysis: extractText(data), provider: "通义千问", model: cfg.modelId });
}

// ============================================================================
// Google Gemini
// ============================================================================
// Docs: https://ai.google.dev/gemini-api/docs/vision
// Endpoint: POST /models/{model}:generateContent

async function callGemini(
  cfg: AIConfig,
  systemMsg: string,
  userPrompt: string,
  imageBase64: string,
  maxTokens: number,
): Promise<Response> {
  const model = cfg.modelId;
  const url = `${cfg.baseUrl}/models/${model}:generateContent?key=${cfg.apiKey}`;

  // Strip data URL prefix if present
  const cleanBase64 = imageBase64.replace(/^data:image\/[^;]+;base64,/, "");
  const mimeMatch = imageBase64.match(/^data:(image\/[^;]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const payload = {
    system_instruction: { parts: [{ text: systemMsg }] },
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mimeType, data: cleanBase64 } },
          { text: userPrompt },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: maxTokens },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][Gemini] API error ${res.status}:`, errBody);
    return errResp(`Gemini API error: ${res.status}`, 502);
  }

  const data = await res.json();
  const analysis = extractText(data);

  return json({ analysis, provider: "Gemini", model });
}

async function callGeminiText(
  cfg: AIConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<Response> {
  const model = cfg.modelId;
  const url = `${cfg.baseUrl}/models/${model}:generateContent?key=${cfg.apiKey}`;

  // Convert OpenAI-style messages to Gemini format
  const systemInstruction = messages.find((m) => m.role === "system")?.content || "";
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][Gemini] Text API error ${res.status}:`, errBody);
    return errResp(`Gemini API error: ${res.status}`, 502);
  }

  const data = await res.json();
  return json({ analysis: extractText(data), provider: "Gemini", model });
}

async function callGeminiAudio(
  cfg: AIConfig,
  systemMsg: string,
  previousAnalysis: string | undefined,
  audioBase64: string,
  mimeType: string,
  maxTokens: number,
): Promise<Response> {
  const model = cfg.modelId;
  const url = `${cfg.baseUrl}/models/${model}:generateContent?key=${cfg.apiKey}`;

  const parts: any[] = [];
  if (previousAnalysis) {
    parts.push({ text: `Previous analysis context:\n${previousAnalysis}` });
  }
  parts.push({ inline_data: { mime_type: mimeType, data: audioBase64 } });
  parts.push({ text: "Please listen to this voice message and respond with helpful agricultural advice." });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemMsg }] },
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][Gemini] Audio API error ${res.status}:`, errBody);
    return errResp(`Gemini audio API error: ${res.status}`, 502);
  }

  const data = await res.json();
  return json({ analysis: extractText(data), provider: "Gemini", model });
}

// ============================================================================
// OpenAI / OpenAI-Compatible
// ============================================================================
// Docs: https://platform.openai.com/docs/guides/vision
// Endpoint: POST /chat/completions

async function callOpenAI(
  cfg: AIConfig,
  systemMsg: string,
  userPrompt: string,
  imageBase64: string,
  maxTokens: number,
): Promise<Response> {
  const url = `${cfg.baseUrl}/chat/completions`;

  // Ensure proper data URL format
  const imageUrl = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const payload = {
    model: cfg.modelId,
    messages: [
      { role: "system", content: systemMsg },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          { type: "text", text: userPrompt },
        ],
      },
    ],
    max_tokens: maxTokens,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][OpenAI] API error ${res.status}:`, errBody);
    return errResp(`OpenAI API error: ${res.status}`, 502);
  }

  const data = await res.json();
  const analysis = extractText(data);

  return json({ analysis, provider: "OpenAI", model: cfg.modelId });
}

async function callOpenAIText(
  cfg: AIConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<Response> {
  const url = `${cfg.baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.modelId,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][OpenAI] Text API error ${res.status}:`, errBody);
    return errResp(`OpenAI API error: ${res.status}`, 502);
  }

  const data = await res.json();
  return json({ analysis: extractText(data), provider: "OpenAI", model: cfg.modelId });
}

async function callOpenAIAudio(
  cfg: AIConfig,
  systemMsg: string,
  previousAnalysis: string | undefined,
  audioBase64: string,
  maxTokens: number,
): Promise<Response> {
  // GPT-4o supports audio via input_audio in the content array
  const url = `${cfg.baseUrl}/chat/completions`;

  const userContent: any[] = [];
  if (previousAnalysis) {
    userContent.push({ type: "text", text: `Previous analysis context:\n${previousAnalysis}` });
  }
  userContent.push({
    type: "input_audio",
    input_audio: { data: audioBase64, format: "webm" },
  });
  userContent.push({ type: "text", text: "Please listen to this voice message and respond with helpful agricultural advice." });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.modelId,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[ai-vision][OpenAI] Audio API error ${res.status}:`, errBody);
    // Fallback: if audio not supported, try as text
    if (res.status === 400) {
      return await callOpenAIText(cfg, [
        { role: "system", content: systemMsg },
        ...(previousAnalysis ? [{ role: "assistant", content: previousAnalysis }] : []),
        { role: "user", content: "[User sent a voice message. Audio transcription is not available. Please ask the user to type their question.]" },
      ], maxTokens);
    }
    return errResp(`OpenAI audio API error: ${res.status}`, 502);
  }

  const data = await res.json();
  return json({ analysis: extractText(data), provider: "OpenAI", model: cfg.modelId });
}
