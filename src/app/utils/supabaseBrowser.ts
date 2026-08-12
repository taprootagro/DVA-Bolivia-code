/**
 * 浏览器端 Supabase 客户端 — 与 ConfigProvider 相同合并规则，供登录 / 回调使用。
 */
import {
  createClient,
  type SupabaseClient,
  type Provider,
  type User,
} from "@supabase/supabase-js";
import { defaultConfig } from "/taprootagrosetting";
import type { HomePageConfig } from "../hooks/useHomeConfig";
import { deepMerge, MERGE_REPLACE } from "./index";
import { storageGetJSON, storageSetJSON } from "./safeStorage";
import { supabaseCookieStorage } from "./supabaseCookieStorage";
import { CONFIG_STORAGE_KEY } from "../constants";

let cached: { key: string; client: SupabaseClient } | null = null;

function mergedHomeConfig(): HomePageConfig {
  const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  if (parsed) return deepMerge(defaultConfig, parsed, MERGE_REPLACE);
  return defaultConfig;
}

/** UI 上的社交 key → Supabase Auth 内置 provider（微信/支付宝/LINE 等需 Dashboard 自定义 OAuth，此处不映射） */
export function uiSocialKeyToProvider(uiKey: string): Provider | null {
  const map: Record<string, Provider> = {
    google: "google",
    facebook: "facebook",
    apple: "apple",
    twitter: "twitter",
  };
  return map[uiKey] ?? null;
}

export function isSupabaseBuiltInSocial(uiKey: string): boolean {
  return uiSocialKeyToProvider(uiKey) !== null;
}

/** 微信 / 支付宝 / LINE：非 Supabase 内置 `Provider`；产品路径为 Edge Function 换票（见 DEPLOY §7.1），不用 signInWithOAuth 直连 */
export function isRegionalEdgeLoginProvider(uiKey: string): boolean {
  return uiKey === "wechat" || uiKey === "alipay" || uiKey === "line";
}

/** @deprecated 使用 isRegionalEdgeLoginProvider 替代 */
export const isWechatAlipayEdgeLoginProvider = isRegionalEdgeLoginProvider;

/** 与 getSupabaseBrowserClient 使用同一套合并后的 backendProxyConfig 判定（含出厂 defaultConfig），避免 LoginPage 仅读 raw localStorage 导致误进演示模式 */
export function isSupabaseAuthConfigured(): boolean {
  const merged = mergedHomeConfig();
  const b = merged.backendProxyConfig;
  if (!b?.enabled) return false;
  const url = (b.supabaseUrl || "").trim();
  const anon = (b.supabaseAnonKey || "").trim();
  return !!url && !url.includes("your-") && !!anon;
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  const merged = mergedHomeConfig();
  const b = merged.backendProxyConfig;
  if (!b?.enabled) return null;
  const url = (b.supabaseUrl || "").trim().replace(/\/$/, "");
  const anon = (b.supabaseAnonKey || "").trim();
  if (!url || url.includes("your-") || !anon) return null;

  const cacheKey = `${url}|${anon.slice(0, 12)}`;
  if (cached?.key === cacheKey) return cached.client;

  const client = createClient(url, anon, {
    auth: {
      storageKey: 'taprootagro-auth',
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      storage: typeof window !== "undefined" ? supabaseCookieStorage : undefined,
      autoRefreshToken: true,
    },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  cached = { key: cacheKey, client };
  return client;
}

if (typeof import.meta !== "undefined" && (import.meta as { hot?: { dispose?: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (cached?.client) {
      try {
        void cached.client.removeAllChannels();
      } catch {
        /* ignore */
      }
      cached = null;
    }
  });
}

export function invalidateSupabaseBrowserClientCache(): void {
  cached = null;
}

/** 将手机号规范为 E.164（无 + 时：中国大陆 11 位 1… 补 +86） */
export function normalizePhoneE164(raw: string): string {
  const c = raw.replace(/[\s\-()]/g, "");
  if (c.startsWith("+")) return c;
  if (/^1\d{10}$/.test(c)) return `+86${c}`;
  return `+${c}`;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Facebook `user_metadata.picture` may be `{ data: { url } }` */
function pictureUrlFromMetadata(meta: Record<string, unknown>): string {
  const p = meta.picture;
  if (typeof p === "string" && isHttpUrl(p)) return p;
  if (p && typeof p === "object" && "data" in p) {
    const u = (p as { data?: { url?: string } }).data?.url;
    if (typeof u === "string" && isHttpUrl(u)) return u;
  }
  return "";
}

/**
 * 从 Supabase User（OAuth / 内置 Provider）解析展示名与头像 URL，仅用于写入本地 userProfile。
 */
export function extractOAuthDisplayProfile(user: User): { name: string; avatar: string } {
  const m = (user.user_metadata || {}) as Record<string, unknown>;
  const avatar =
    (typeof m.avatar_url === "string" && isHttpUrl(m.avatar_url) ? m.avatar_url : "") ||
    pictureUrlFromMetadata(m) ||
    (typeof m.picture === "string" && isHttpUrl(m.picture) ? m.picture : "") ||
    (typeof m.profile_image_url_https === "string" && isHttpUrl(m.profile_image_url_https)
      ? m.profile_image_url_https
      : "") ||
    "";
  const name =
    (typeof m.full_name === "string" && m.full_name) ||
    (typeof m.name === "string" && m.name) ||
    (typeof m.user_name === "string" && m.user_name) ||
    (typeof m.preferred_username === "string" && m.preferred_username) ||
    (typeof m.nickname === "string" && m.nickname) ||
    (user.email ? user.email.split("@")[0] : "") ||
    "";
  return { name: String(name).trim(), avatar: String(avatar).trim() };
}

/** 合并到 localStorage 中的 home 配置（不调用 Edge 写 profile） */
export function applyOAuthMetadataToLocalProfile(user: User): void {
  const { name, avatar } = extractOAuthDisplayProfile(user);
  if (!name && !avatar) return;
  const current = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  const baseCfg = current ? deepMerge(defaultConfig, current, MERGE_REPLACE) : mergedHomeConfig();
  const next: HomePageConfig = {
    ...baseCfg,
    userProfile: {
      ...baseCfg.userProfile,
      name: name || baseCfg.userProfile?.name || "",
      avatar: avatar || baseCfg.userProfile?.avatar || "",
    },
  };
  storageSetJSON(CONFIG_STORAGE_KEY, next);
  window.dispatchEvent(new CustomEvent("configUpdate", { detail: next }));
}

/** 微信换票响应里的 oauthProfile（仅客户端展示） */
export function applyLocalProfileFromOauthPatch(patch: {
  name?: string | null;
  avatar?: string | null;
}): void {
  const name = patch.name != null ? String(patch.name).trim() : "";
  const avatar = patch.avatar != null ? String(patch.avatar).trim() : "";
  if (!name && !avatar) return;
  const current = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  const baseCfg = current ? deepMerge(defaultConfig, current, MERGE_REPLACE) : mergedHomeConfig();
  const next: HomePageConfig = {
    ...baseCfg,
    userProfile: {
      ...baseCfg.userProfile,
      name: name || baseCfg.userProfile?.name || "",
      avatar: avatar || baseCfg.userProfile?.avatar || "",
    },
  };
  storageSetJSON(CONFIG_STORAGE_KEY, next);
  window.dispatchEvent(new CustomEvent("configUpdate", { detail: next }));
}

/** 将 GET /profile 返回的字段写入本地 home 配置（列优先，无列则保留 profile JSON 中的 name/avatar） */
export function applyServerProfilePayloadToLocalConfig(
  pResData: Record<string, unknown>,
): void {
  if (!pResData || typeof pResData !== "object") return;

  const current = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  const baseCfg = current ? deepMerge(defaultConfig, current, MERGE_REPLACE) : mergedHomeConfig();

  const hasCols =
    "displayName" in pResData ||
    "avatarUrl" in pResData ||
    "phone" in pResData ||
    "pickupAddress" in pResData;

  const prof = pResData.profile as Record<string, unknown> | null | undefined;
  const legacyName = prof && typeof prof.name === "string" ? prof.name : "";
  const legacyAvatar = prof && typeof prof.avatar === "string" ? prof.avatar : "";

  let name = baseCfg.userProfile?.name ?? "";
  let avatar = baseCfg.userProfile?.avatar ?? "";
  let phone = baseCfg.userProfile?.phone ?? "";
  let pickupAddress = baseCfg.userProfile?.pickupAddress ?? "";

  if (hasCols) {
    if (typeof pResData.displayName === "string") name = pResData.displayName;
    if (typeof pResData.avatarUrl === "string") {
      const fromServer = pResData.avatarUrl.trim();
      if (fromServer) avatar = fromServer;
    }
    if (typeof pResData.phone === "string") phone = pResData.phone;
    if (typeof pResData.pickupAddress === "string") {
      pickupAddress = pResData.pickupAddress;
    }
  } else if (legacyName || legacyAvatar) {
    if (legacyName) name = legacyName;
    if (legacyAvatar) avatar = legacyAvatar;
  } else {
    return;
  }

  const next: HomePageConfig = {
    ...baseCfg,
    userProfile: {
      ...baseCfg.userProfile,
      name,
      avatar,
      phone,
      pickupAddress,
    },
  };
  storageSetJSON(CONFIG_STORAGE_KEY, next);
  window.dispatchEvent(new CustomEvent("configUpdate", { detail: next }));
}

/**
 * 登录成功后从 Edge /profile 拉取档案并写入本地配置
 */
export async function syncUserProfileFromServer(accessToken: string): Promise<void> {
  const merged = mergedHomeConfig();
  const bpc = merged.backendProxyConfig;
  if (!bpc?.supabaseUrl?.trim() || !accessToken) return;

  const base = bpc.supabaseUrl.replace(/\/$/, "");
  const fn = bpc.edgeFunctionName || "server";
  const profileUrl = `${base}/functions/v1/${fn}/profile`;

  try {
    const profileRes = await fetch(profileUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(bpc.supabaseAnonKey ? { apikey: bpc.supabaseAnonKey } : {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!profileRes.ok) return;
    const pResData = (await profileRes.json()) as Record<string, unknown>;
    applyServerProfilePayloadToLocalConfig(pResData);
  } catch {
    /* non-fatal */
  }
}

/**
 * 微信 / 支付宝：用授权码调用统一 Edge `server` 换票，并写入浏览器 Supabase 会话。
 * 需在 Dashboard Secrets 配置 WECHAT_* / ALIPAY_*；数据库需有 `regional_oauth_identities`（见 001_init.sql）。
 */
export async function exchangeRegionalOAuthCode(
  platform: "wechat" | "alipay" | "line",
  code: string,
  redirectUri?: string,
): Promise<{
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}> {
  const merged = mergedHomeConfig();
  const b = merged.backendProxyConfig;
  if (!b?.enabled) {
    throw new Error("Backend proxy not enabled");
  }
  const urlRaw = (b.supabaseUrl || "").trim().replace(/\/$/, "");
  const anon = (b.supabaseAnonKey || "").trim();
  if (!urlRaw || urlRaw.includes("your-") || !anon) {
    throw new Error("Supabase URL or anon key missing");
  }
  const fn = (b.edgeFunctionName || "server").replace(/^\//, "");
  const path =
    platform === "wechat" ? "wechat/exchange" :
    platform === "alipay" ? "alipay/exchange" :
    "line/exchange";
  const endpoint = `${urlRaw}/functions/v1/${fn}/${path}`;
  const payload: Record<string, string> =
    platform === "alipay"
      ? { auth_code: code.trim(), code: code.trim() }
      : { code: code.trim() };

  // LINE requires redirect_uri to match the authorization request
  if (platform === "line" && redirectUri) {
    payload.redirect_uri = redirectUri;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anon,
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as {
    error?: string;
    userId?: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    expiresIn?: number | null;
    oauthProfile?: { name?: string | null; avatar?: string | null };
  };
  if (!res.ok) {
    throw new Error(data?.error || `Regional exchange failed (${res.status})`);
  }
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  if (!data.userId || !accessToken || !refreshToken) {
    throw new Error(data?.error || "Invalid regional exchange response");
  }

  const client = getSupabaseBrowserClient();
  if (client) {
    const { error: sessErr } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessErr) throw new Error(sessErr.message);
    if (data.oauthProfile) {
      applyLocalProfileFromOauthPatch(data.oauthProfile);
    } else {
      const { data: udata } = await client.auth.getUser();
      if (udata.user) applyOAuthMetadataToLocalProfile(udata.user);
    }
  }

  return {
    userId: data.userId,
    accessToken,
    refreshToken,
    expiresIn: data.expiresIn ?? null,
  };
}
