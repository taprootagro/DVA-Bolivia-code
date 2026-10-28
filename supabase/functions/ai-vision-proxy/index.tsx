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
//   1. Image analysis:   { image, detections, uiLanguage? } — systemPrompt / modelId / maxTokens from app_config (cached), not client body
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
//   AI_MODEL_ID    — (Optional) Model ID override (wins over app_config.cloudAIConfig.modelId)
//   AI_MODEL_ALLOWLIST — (Optional) Comma list; client modelId is ignored unless listed here,
//                        and app_config.modelId must also be listed when this is set
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
    "Content-Type, Authorization, apikey, x-client-info, Accept",
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

function modelAllowlist(): string[] {
  const raw = (Deno.env.get("AI_MODEL_ALLOWLIST") || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Client-supplied modelId is honored only when ops list it in AI_MODEL_ALLOWLIST (empty list = never). */
function isClientModelIdAllowed(modelId: unknown): boolean {
  if (typeof modelId !== "string" || !modelId.trim()) return false;
  return modelAllowlist().includes(modelId.trim());
}

const DEFAULT_BASE_URLS: Record<AIProvider, string> = {
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
};

const DEFAULT_MODELS: Record<AIProvider, string> = {
  qwen: "qwen-vl-plus",
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o",
};

/** AI_MODEL_ID > app_config modelId > allowlisted client modelId > provider default. */
function resolveModelId(provider: AIProvider, cloudModelId: string, requestModelId?: unknown): string {
  const envModel = (Deno.env.get("AI_MODEL_ID") || "").trim();
  if (envModel) return envModel;
  const list = modelAllowlist();
  if (cloudModelId && (list.length === 0 || list.includes(cloudModelId))) return cloudModelId;
  if (isClientModelIdAllowed(requestModelId)) return (requestModelId as string).trim();
  const fallback = DEFAULT_MODELS[provider] || DEFAULT_MODELS.qwen;
  if (list.length > 0 && !list.includes(fallback)) return list[0];
  return fallback;
}

function getAIConfig(cloudModelId = "", requestModelId?: unknown): AIConfig {
  const provider = (Deno.env.get("AI_PROVIDER") || "qwen") as AIProvider;
  return {
    provider,
    apiKey: Deno.env.get("AI_API_KEY") || "",
    baseUrl: Deno.env.get("AI_BASE_URL") || DEFAULT_BASE_URLS[provider] || DEFAULT_BASE_URLS.qwen,
    modelId: resolveModelId(provider, cloudModelId, requestModelId),
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

const JWT_USER_CACHE_MAX = 2000;
const jwtUserCache = new Map<string, { userId: string; expAt: number }>();

function jwtCacheTtlMs(jwt: string): number {
  try {
    const part = jwt.split(".")[1];
    if (!part) return 60_000;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64)) as { exp?: number };
    if (typeof payload.exp === "number") {
      const ms = payload.exp * 1000 - Date.now();
      return Math.min(60_000, Math.max(1_000, ms));
    }
  } catch {
    /* ignore */
  }
  return 60_000;
}

function trimJwtUserCache(): void {
  while (jwtUserCache.size > JWT_USER_CACHE_MAX) {
    const first = jwtUserCache.keys().next().value;
    if (first === undefined) break;
    jwtUserCache.delete(first);
  }
}

async function getAuthUserId(jwt: string): Promise<string | null> {
  const hit = jwtUserCache.get(jwt);
  if (hit && hit.expAt > Date.now()) return hit.userId;

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  if (!anonKey || !url) return null;
  try {
    const client = bearerUserClient(jwt);
    const { data, error } = await client.auth.getUser(jwt);
    if (error || !data?.user?.id) return null;
    jwtUserCache.set(jwt, {
      userId: data.user.id,
      expAt: Date.now() + jwtCacheTtlMs(jwt),
    });
    trimJwtUserCache();
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
  modelId: string;
  maxTokens: number | null;
  intervalSec: number;
  dailyLimit: number;
  windowPerMin: number;
  maxConcurrent: number;
};

function envQueueMaxCap(): number {
  return Math.max(1, envInt("AI_QUEUE_MAX_CAP", 100));
}

function clampQueueMax(n: number): number {
  const cap = envQueueMaxCap();
  return Math.min(cap, Math.max(1, Math.floor(n)));
}

function upstreamTimeoutMs(): number {
  const v = parseInt(Deno.env.get("AI_UPSTREAM_TIMEOUT_MS") || "", 10);
  if (Number.isFinite(v) && v >= 5_000) return Math.min(120_000, v);
  return 50_000;
}

function upstreamTimeoutSec(): number {
  return Math.ceil(upstreamTimeoutMs() / 1000);
}

function envQueueDefaults(): { maxConcurrent: number; leaseSec: number; retrySec: number } {
  const upstreamSec = upstreamTimeoutSec();
  const minLeaseSec = upstreamSec + 15;
  const configuredLease = envInt("AI_QUEUE_LEASE_SEC", 120);
  return {
    maxConcurrent: clampQueueMax(envInt("AI_QUEUE_MAX_CONCURRENT", envQueueMaxCap())),
    leaseSec: Math.min(300, Math.max(minLeaseSec, Math.max(30, configuredLease))),
    retrySec: Math.min(30, Math.max(3, envInt("AI_QUEUE_RETRY_SEC", 8))),
  };
}

async function providerFetch(url: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(upstreamTimeoutMs()),
  });
}

function upstreamBusyResponse(retrySec = 15): Response {
  const sec = Math.min(60, Math.max(5, Math.floor(retrySec)));
  return json({ error: "UPSTREAM_BUSY", retry_after_seconds: sec }, 503);
}

/** Bad key / unknown model are not transient: 502 tells clients not to offer retry (still refunded). */
async function providerErrorResponse(res: Response, label: string): Promise<Response> {
  const errBody = await res.text();
  console.error(
    `[ai-vision][${label}] API error ${res.status}:`,
    errBody.slice(0, 800),
  );
  if (res.status === 401 || res.status === 403) {
    return json({ error: "PROVIDER_AUTH" }, 502);
  }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    return json({ error: "PROVIDER_CONFIG" }, 502);
  }
  return upstreamBusyResponse(res.status === 429 ? 30 : 15);
}

async function invokeProvider(
  label: string,
  url: string,
  init: RequestInit,
  mode: "json" | "stream" = "json",
): Promise<Response> {
  try {
    let res: Response;
    if (mode === "stream") {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), upstreamTimeoutMs());
      try {
        res = await fetch(url, { ...init, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    } else {
      res = await providerFetch(url, init);
    }
    if (!res.ok) return await providerErrorResponse(res, label);
    return res;
  } catch (e) {
    console.error(`[ai-vision][${label}] fetch failed`, e);
    return upstreamBusyResponse(15);
  }
}

function streamMaxMs(): number {
  return Math.min(180_000, Math.max(upstreamTimeoutMs(), envInt("AI_STREAM_MAX_MS", 120_000)));
}

function sseHeaders(): HeadersInit {
  return {
    ...CORS_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
  };
}

function pipeProviderSse(
  upstream: Response,
  kind: "openai" | "gemini",
  provider: string,
  model: string,
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const holder: UsageBits = { model, ok: false };
  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      let full = "";
      try {
        if (!upstream.body) {
          send({ error: "UPSTREAM_BUSY" });
          return;
        }
        const reader = upstream.body.getReader();
        let buf = "";
        while (true) {
          if (Date.now() - started > streamMaxMs()) {
            send({ error: "UPSTREAM_BUSY" });
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let data: any;
            try {
              data = JSON.parse(payload);
            } catch {
              continue;
            }
            const delta = kind === "openai"
              ? String(data.choices?.[0]?.delta?.content ?? "")
              : extractText(data);
            if (delta) {
              full += delta;
              send({ delta });
            }
            const u = usageFromProviderPayload(data);
            if (u.prompt_tokens != null || u.completion_tokens != null) {
              holder.prompt_tokens = u.prompt_tokens ?? holder.prompt_tokens;
              holder.completion_tokens = u.completion_tokens ?? holder.completion_tokens;
            }
          }
        }
        holder.ok = true;
        send({ done: true, analysis: full, provider, model });
      } catch (e) {
        console.error("[ai-vision] stream pipe failed", e);
        send({ error: "UPSTREAM_BUSY" });
      } finally {
        try { await upstream.body?.cancel(); } catch { /* ignore */ }
        controller.close();
      }
    },
    cancel() {
      try { void upstream.body?.cancel(); } catch { /* ignore */ }
    },
  });
  return rememberUsage(new Response(stream, { status: 200, headers: sseHeaders() }), holder);
}

function attachStreamLifecycle(
  resp: Response,
  onSettle: (ok: boolean) => Promise<void>,
): Response {
  const src = resp.body;
  if (!src) {
    void onSettle(false);
    return resp;
  }
  let once = false;
  const finish = (ok: boolean) => {
    if (once) return;
    once = true;
    void onSettle(ok);
  };
  const holder = usageByResponse.get(resp);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = src.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        finish(holder?.ok === true);
        controller.close();
      } catch (e) {
        finish(false);
        controller.error(e);
      }
    },
    cancel() {
      finish(false);
      void src.cancel();
    },
  });
  const wrapped = new Response(stream, { status: resp.status, headers: resp.headers });
  if (holder) usageByResponse.set(wrapped, holder);
  return wrapped;
}

async function completeOpenAiStyle(
  label: string,
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
  provider: string,
  model: string,
): Promise<Response> {
  const stream = requestWantsStream;
  const res = await invokeProvider(label, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(stream ? { ...payload, stream: true } : payload),
  }, stream ? "stream" : "json");
  if (!res.ok) return res;
  if (stream) return pipeProviderSse(res, "openai", provider, model);
  const data = await res.json();
  return rememberUsage(
    json({ analysis: extractText(data), provider, model }),
    { model, ...usageFromProviderPayload(data), ok: true },
  );
}

async function completeGeminiStyle(
  label: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const stream = requestWantsStream;
  const url = stream
    ? `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`
    : `${baseUrl}/models/${model}:generateContent`;
  const res = await invokeProvider(label, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload),
  }, stream ? "stream" : "json");
  if (!res.ok) return res;
  if (stream) return pipeProviderSse(res, "gemini", "Gemini", model);
  const data = await res.json();
  return rememberUsage(
    json({ analysis: extractText(data), provider: "Gemini", model }),
    { model, ...usageFromProviderPayload(data), ok: true },
  );
}

async function refundRateLimit(admin: SupabaseClient, userId: string): Promise<void> {
  try {
    const { error } = await admin.rpc("ai_rate_limit_refund", { p_user_id: userId });
    if (error) console.warn("[ai-vision-proxy] ai_rate_limit_refund error:", error);
  } catch (e) {
    console.warn("[ai-vision-proxy] ai_rate_limit_refund exception:", e);
  }
}

async function shouldRefundQuotaForResponse(resp: Response): Promise<boolean> {
  if (resp.status === 503) {
    try {
      const data = await resp.clone().json();
      return data?.error === "UPSTREAM_BUSY";
    } catch {
      return true;
    }
  }
  return resp.status >= 500;
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
      p_retry_sec: q.retrySec,
    });
    if (error) {
      console.error("[ai-vision-proxy] ai_queue_try_acquire error:", error);
      return { ok: false, retryAfter: q.retrySec, queueDepth: undefined };
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
    return { ok: false, retryAfter: q.retrySec, queueDepth: undefined };
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

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * One app_config read for systemPrompt / modelId / maxTokens + rate limits (short TTL), merged with
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
  let modelId = "";
  let maxTokens: number | null = null;
  let intervalSec = fb.intervalSec;
  let dailyLimit = fb.dailyLimit;
  let windowPerMin = fb.windowPerMin;
  let maxConcurrent = qd.maxConcurrent;
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
        if (typeof c.modelId === "string" && MODEL_ID_RE.test(c.modelId.trim())) {
          modelId = c.modelId.trim();
        }
        const mt = c.maxTokens;
        if (typeof mt === "number" && Number.isFinite(mt) && mt >= 64) {
          maxTokens = Math.floor(mt);
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
    modelId,
    maxTokens,
    intervalSec,
    dailyLimit,
    windowPerMin,
    maxConcurrent,
  };
  return appConfigCloudCache;
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

function sanitizeClientBody(
  body: Record<string, unknown>,
  cloudCfg: AppConfigCloudState,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const tokenCap = envInt("AI_MAX_TOKENS_CAP", 2048);
  const rawTokens = cloudCfg.maxTokens ?? out.maxTokens;
  if (typeof rawTokens === "number" && Number.isFinite(rawTokens)) {
    out.maxTokens = Math.min(tokenCap, Math.max(64, Math.floor(rawTokens)));
  } else {
    out.maxTokens = Math.min(tokenCap, 1024);
  }
  if (!isClientModelIdAllowed(out.modelId)) {
    delete out.modelId;
  }
  if (typeof out.previousAnalysis === "string" && out.previousAnalysis.length > 12_000) {
    out.previousAnalysis = out.previousAnalysis.slice(-12_000);
  }
  if (typeof out.userMessage === "string" && out.userMessage.length > 2_000) {
    out.userMessage = out.userMessage.slice(0, 2_000);
  }
  out.history = sanitizeHistory(out.history);
  return out;
}

type ChatTurn = { role: "user" | "assistant"; content: string };

function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw.slice(-10)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { role?: unknown; content?: unknown };
    const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const content = typeof rec.content === "string" ? rec.content.slice(0, 2_000) : "";
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

const IMAGE_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,/;

/** Only accept the data URLs the client compressor produces (no remote URLs / other MIME forwarded upstream). */
function invalidImageError(image: unknown): "BAD_IMAGE" | "PAYLOAD_TOO_LARGE" | null {
  if (image === undefined || image === null) return null;
  if (typeof image !== "string" || !IMAGE_DATA_URL_RE.test(image)) return "BAD_IMAGE";
  if (image.length > envInt("AI_MAX_IMAGE_CHARS", 1_000_000)) return "PAYLOAD_TOO_LARGE";
  return null;
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

type UsageBits = {
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  latency_ms?: number | null;
  status?: string | null;
  ok?: boolean;
};

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
}

function usageFromProviderPayload(data: any): Pick<UsageBits, "prompt_tokens" | "completion_tokens"> {
  const u = data?.usage;
  if (u && typeof u === "object") {
    return {
      prompt_tokens: numOrNull(u.prompt_tokens ?? u.input_tokens),
      completion_tokens: numOrNull(u.completion_tokens ?? u.output_tokens),
    };
  }
  const g = data?.usageMetadata;
  if (g && typeof g === "object") {
    return {
      prompt_tokens: numOrNull(g.promptTokenCount),
      completion_tokens: numOrNull(g.candidatesTokenCount),
    };
  }
  return {};
}

const usageByResponse = new WeakMap<Response, UsageBits>();

function rememberUsage(resp: Response, bits: UsageBits): Response {
  usageByResponse.set(resp, bits);
  return resp;
}

/** Set for the current POST; vision/text completions honor it. Voice stays JSON. */
let requestWantsStream = false;

/** 成功调用 AI 后异步记录一行 ai_usage（滑动窗口依据；A12 附带 model/tokens/latency/status） */
function recordAiUsage(
  admin: SupabaseClient,
  userId: string,
  route: string,
  provider: string,
  ip: string,
  extra?: UsageBits,
): void {
  waitUntil(
    Promise.resolve(
      admin
        .from("ai_usage")
        .insert({
          user_id: userId,
          route,
          provider,
          ip,
          model: extra?.model ?? null,
          prompt_tokens: extra?.prompt_tokens ?? null,
          completion_tokens: extra?.completion_tokens ?? null,
          latency_ms: extra?.latency_ms ?? null,
          status: extra?.status ?? "ok",
        })
        .then(({ error }) => {
          if (error) console.warn("[ai-vision-proxy] insert ai_usage failed", error);
        }),
    ),
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
      const cloudCfg = await getAppConfigCloudCache(adminClient());
      const cfg = getAIConfig(cloudCfg.modelId);
      return json({
        status: "ok",
        timestamp: new Date().toISOString(),
        provider: cfg.provider,
        modelId: cfg.modelId,
        configured: !!cfg.apiKey,
      });
    }

    // POST / — Main analysis endpoint（鉴权 + 限流；网关 verify_jwt=true）
    if ((route === "/" || route === "") && method === "POST") {
      const admin = adminClient();
      const cloudCfg = await getAppConfigCloudCache(admin);
      const jwt = extractUserJwt(req);
      if (!jwt) {
        return errResp("unauthorized", 401);
      }
      const userId = await getAuthUserId(jwt);
      if (!userId) {
        return errResp("unauthorized", 401);
      }

      const maxBodyBytes = envInt("AI_MAX_BODY_BYTES", 2_000_000);
      const rawBody = await req.text();
      if (rawBody.length > maxBodyBytes) {
        return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
      }
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return json({ error: "BAD_JSON" }, 400);
        }
        body = sanitizeClientBody(parsed as Record<string, unknown>, cloudCfg);
      } catch {
        return json({ error: "BAD_JSON" }, 400);
      }
      const imageError = invalidImageError(body.image);
      if (imageError) {
        return json({ error: imageError }, imageError === "PAYLOAD_TOO_LARGE" ? 413 : 400);
      }

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

      let releasedByStream = false;
      try {
        const gate = await enforceRateLimit(admin, userId);
        if (!gate.ok) {
          return json(
            { error: gate.code, retry_after_seconds: gate.retryAfter ?? null },
            429,
          );
        }

        const wantStream = (req.headers.get("accept") || "").includes("text/event-stream");
        const startedAt = Date.now();
        const resp = await handleAnalysis(body, cloudCfg, wantStream);

        const provider = (Deno.env.get("AI_PROVIDER") || "qwen");
        const ip = getClientIp(req);
        const usageRoute = routeHint === "analysis" ? "analysis" : routeHint;
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("text/event-stream")) {
          releasedByStream = true;
          return attachStreamLifecycle(resp, async (ok) => {
            await releaseQueue(admin, lease.leaseId);
            const bits = usageByResponse.get(resp);
            if (ok) {
              recordAiUsage(admin, userId, usageRoute, provider, ip, {
                ...bits,
                latency_ms: Date.now() - startedAt,
                status: "ok",
              });
            } else {
              await refundRateLimit(admin, userId);
            }
          });
        }

        if (resp.status >= 200 && resp.status < 300) {
          const bits = usageByResponse.get(resp);
          recordAiUsage(admin, userId, usageRoute, provider, ip, {
            ...bits,
            latency_ms: Date.now() - startedAt,
            status: "ok",
          });
        } else if (await shouldRefundQuotaForResponse(resp)) {
          await refundRateLimit(admin, userId);
        }

        return resp;
      } finally {
        if (!releasedByStream) await releaseQueue(admin, lease.leaseId);
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

async function handleAnalysis(body: any, cloudCfg: AppConfigCloudState, wantStream = false): Promise<Response> {
  const cfg = getAIConfig(cloudCfg.modelId, body.modelId);

  requestWantsStream = wantStream === true && !body.voiceFollowUp;

  if (!cfg.apiKey) {
    return errResp(
      `AI provider '${cfg.provider}' not configured. Set AI_API_KEY in Edge Function secrets.`,
      500,
    );
  }

  const dbPrompt = cloudCfg.systemPrompt;

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
  const { userMessage, previousAnalysis, systemPrompt, maxTokens, uiLanguage, history } = body;

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

  const messages = buildTextMessages(systemMsg, previousAnalysis, userMessage, history);
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
  const { image, userMessage, previousAnalysis, systemPrompt, maxTokens, uiLanguage, history } = body;

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

  const contextBlock = formatHistoryContext(previousAnalysis, history);
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
  const { audio, previousAnalysis, systemPrompt, maxTokens, uiLanguage, history } = body;

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
      return await callGeminiAudio(cfg, systemMsg, formatHistoryContext(previousAnalysis, history) || previousAnalysis, audioBase64, mimeType, tokenLimit);
    case "openai":
      // GPT-4o supports audio in input_audio format
      return await callOpenAIAudio(cfg, systemMsg, formatHistoryContext(previousAnalysis, history) || previousAnalysis, audioBase64, tokenLimit);
    case "qwen":
      // Qwen VL doesn't natively support audio — fallback to text
      return await callQwenText(cfg, buildTextMessages(
        systemMsg,
        previousAnalysis,
        "[User sent a voice message. Audio transcription is not available for this provider. Please ask the user to type their question.]",
        history,
      ), tokenLimit);
    default:
      return errResp(`Unsupported provider: ${cfg.provider}`);
  }
}

// ============================================================================
// Provider Implementations
// ============================================================================

// ---- Helper: Build text messages ----

function formatHistoryContext(previousAnalysis: string | undefined, history?: ChatTurn[]): string {
  const parts: string[] = [];
  if (previousAnalysis) parts.push(`Previous analysis:\n${previousAnalysis}`);
  if (history && history.length) {
    parts.push(history.map((t) => `[${t.role}]: ${t.content}`).join("\n"));
  }
  return parts.length ? parts.join("\n\n") + "\n\n" : "";
}

function buildTextMessages(
  systemMsg: string,
  previousAnalysis: string | undefined,
  userMessage: string,
  history?: ChatTurn[],
): { role: string; content: string }[] {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemMsg },
  ];
  if (previousAnalysis) {
    messages.push({ role: "assistant", content: previousAnalysis });
  }
  if (history && history.length) {
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }
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

  return await completeOpenAiStyle("Qwen", url, {
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
  }, cfg.apiKey, "通义千问", cfg.modelId);
}

async function callQwenText(
  cfg: AIConfig,
  messages: { role: string; content: any }[],
  maxTokens: number,
): Promise<Response> {
  const url = `${cfg.baseUrl}/chat/completions`;

  return await completeOpenAiStyle("Qwen", url, {
    model: cfg.modelId.replace("-vl-", "-"), // Use text model for follow-ups
    messages,
    max_tokens: maxTokens,
  }, cfg.apiKey, "通义千问", cfg.modelId);
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
  const cleanBase64 = imageBase64.replace(/^data:image\/[^;]+;base64,/, "");
  const mimeMatch = imageBase64.match(/^data:(image\/[^;]+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

  return await completeGeminiStyle("Gemini", cfg.baseUrl, model, cfg.apiKey, {
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
  });
}

async function callGeminiText(
  cfg: AIConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<Response> {
  const model = cfg.modelId;
  const systemInstruction = messages.find((m) => m.role === "system")?.content || "";
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  return await completeGeminiStyle("Gemini", cfg.baseUrl, model, cfg.apiKey, {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  });
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
  const url = `${cfg.baseUrl}/models/${model}:generateContent`;

  const parts: any[] = [];
  if (previousAnalysis) {
    parts.push({ text: `Previous analysis context:\n${previousAnalysis}` });
  }
  parts.push({ inline_data: { mime_type: mimeType, data: audioBase64 } });
  parts.push({ text: "Please listen to this voice message and respond with helpful agricultural advice." });

  const res = await invokeProvider("Gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemMsg }] },
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) return res;

  const data = await res.json();
  return rememberUsage(
    json({ analysis: extractText(data), provider: "Gemini", model }),
    { model, ...usageFromProviderPayload(data), ok: true },
  );
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

  return await completeOpenAiStyle("OpenAI", url, {
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
  }, cfg.apiKey, "OpenAI", cfg.modelId);
}

async function callOpenAIText(
  cfg: AIConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<Response> {
  const url = `${cfg.baseUrl}/chat/completions`;

  return await completeOpenAiStyle("OpenAI", url, {
    model: cfg.modelId,
    messages,
    max_tokens: maxTokens,
  }, cfg.apiKey, "OpenAI", cfg.modelId);
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

  let res: Response;
  try {
    res = await providerFetch(url, {
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
  } catch (e) {
    console.error("[ai-vision][OpenAI] Audio fetch failed", e);
    return upstreamBusyResponse(15);
  }

  if (res.status === 400) {
    return await callOpenAIText(cfg, [
      { role: "system", content: systemMsg },
      ...(previousAnalysis ? [{ role: "assistant", content: previousAnalysis }] : []),
      { role: "user", content: "[User sent a voice message. Audio transcription is not available. Please ask the user to type their question.]" },
    ], maxTokens);
  }
  if (!res.ok) return await providerErrorResponse(res, "OpenAI");

  const data = await res.json();
  return rememberUsage(
    json({ analysis: extractText(data), provider: "OpenAI", model: cfg.modelId }),
    { model: cfg.modelId, ...usageFromProviderPayload(data), ok: true },
  );
}
