import { createClient } from '@supabase/supabase-js';
import type { HomePageConfig } from '../hooks/useHomeConfig';
import { CONFIG_CMS_DIRTY_KEY } from '../constants';
import { deepMerge, MERGE_REPLACE } from '../utils';

/** CMS fields merged from local when Config Manager has unsynced local saves (see CONFIG_CMS_DIRTY_KEY). */
const CMS_FIELD_KEYS = [
  'banners',
  'navigation',
  'liveStreams',
  'articles',
  'videoFeed',
  'marketPage',
  'currencySymbol',
  'filing',
  'aboutUs',
  'privacyPolicy',
  'termsOfService',
  'technicalSupport',
  'appBranding',
  'splashScreen',
  'homeIcons',
  'communityUiMode',
  'desktopIcon',
  'pushConfig',
  'pushProvidersConfig',
  'aiModelConfig',
  'cloudAIConfig',
  'loginConfig',
  'liveShareConfig',
  'liveNavigationConfig',
  'profileEditCooldownSeconds',
] as const satisfies readonly (keyof HomePageConfig)[];

export function markConfigCmsDirty(): void {
  try {
    localStorage.setItem(CONFIG_CMS_DIRTY_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function clearConfigCmsDirty(): void {
  try {
    localStorage.removeItem(CONFIG_CMS_DIRTY_KEY);
  } catch {
    /* ignore */
  }
}

function isConfigCmsDirty(): boolean {
  try {
    return localStorage.getItem(CONFIG_CMS_DIRTY_KEY) === '1';
  } catch {
    return false;
  }
}

function pickCmsOverlay(local: HomePageConfig): Partial<HomePageConfig> {
  const o: Partial<HomePageConfig> = {};
  for (const k of CMS_FIELD_KEYS) {
    (o as Record<string, unknown>)[k] = local[k] as unknown;
  }
  return o;
}

/** CMS 未推送云端时，backendProxy 里由内容管理器编辑的字段应保留本地值。 */
function pickLocalBackendCmsOverlay(
  local: HomePageConfig,
): Partial<NonNullable<HomePageConfig['backendProxyConfig']>> {
  const l = local.backendProxyConfig;
  if (!l) return {};
  const o: Partial<NonNullable<HomePageConfig['backendProxyConfig']>> = {};
  if (typeof l.mediaCdnBaseUrl === 'string') o.mediaCdnBaseUrl = l.mediaCdnBaseUrl;
  if (l.cmsStorageProvider) o.cmsStorageProvider = l.cmsStorageProvider;
  return o;
}

// ============================================================
// ConfigSyncService — Remote config sync via Edge Function
// ============================================================
// All reads and writes go through the unified Edge Function
// (POST /server/config, GET /server/config) which uses
// service_role internally — the frontend never directly
// touches the app_config table.
//
// The Edge Function is called with the anonKey in the `apikey`
// header (standard Supabase Edge Function auth).
//
// Remote config READ (GET /config): anon — farmer app merges into localStorage
// on mount / foreground (see mergeRemoteAppConfigIntoLocal).
//
// Remote config WRITE (POST /config): content admins / write secret. Farmer
// client does not POST. Server still requires CONFIG_WRITE_SECRET or legacy
// ALLOW_INSECURE_PUBLIC_CONFIG_WRITE for any caller (e.g. curl, internal tools).
// White-label operators maintain app_config in Supabase Dashboard after launch.
//
// When supabaseUrl / anonKey are placeholder values, the
// service gracefully returns null / skips writes so the app
// works fully offline.
// ============================================================

const TAG = '[ConfigSync]';

/** Remove fields that must never be stored in app_config (defensive). */
function stripSecretsFromConfigForRemote(config: Record<string, any>): Record<string, any> {
  const c = JSON.parse(JSON.stringify(config)) as Record<string, any>;
  if (c.backendProxyConfig && typeof c.backendProxyConfig === 'object') {
    delete c.backendProxyConfig.configWriteSecret;
  }
  // Per-user profile stays local + Edge /profile; never publish via CMS push.
  delete c.userProfile;
  return c;
}

// ---- Credential validation ----

/**
 * Check whether a URL/key pair looks like real Supabase credentials
 * (i.e. not placeholder / empty / default template values).
 */
export function isSupabaseConfigured(url?: string, anonKey?: string): boolean {
  if (!url || !anonKey) return false;
  if (url.includes('your-supabase') || anonKey.includes('your-supabase')) return false;
  if (url === 'https://your-supabase-project.supabase.co') return false;
  if (anonKey === 'your-supabase-anon-key') return false;
  if (url.length < 20 || anonKey.length < 20) return false;
  try {
    new URL(url);
  } catch {
    return false;
  }
  return true;
}

// ---- Helpers ----

/**
 * Build the full Edge Function URL.
 * e.g. https://xxx.supabase.co/functions/v1/server/config
 */
function edgeFnUrl(
  supabaseUrl: string,
  edgeFunctionName: string,
  path: string,
): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  return `${base}/functions/v1/${edgeFunctionName}${path}`;
}

/**
 * Standard headers for Edge Function calls.
 * Supabase requires the `apikey` header to authenticate the request.
 */
function edgeHeaders(anonKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'apikey': anonKey,
    // Authorization with anonKey as Bearer is the standard pattern
    // for Edge Functions when no user JWT is available
    'Authorization': `Bearer ${anonKey}`,
  };
}

/** GET /config: optional user JWT so content admins receive full config (e.g. systemPrompt). */
function edgeHeadersForConfigRead(
  anonKey: string,
  opts?: { userAccessToken?: string | null },
): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'apikey': anonKey,
  };
  const ut = opts?.userAccessToken?.trim();
  if (ut) {
    h['Authorization'] = `Bearer ${ut}`;
  } else {
    h['Authorization'] = `Bearer ${anonKey}`;
  }
  return h;
}

export type FetchRemoteConfigOptions = {
  userAccessToken?: string | null;
};

export type PushRemoteOptions = {
  /** Logged-in user's access token — required for content super-admins (POST /config). */
  userAccessToken?: string | null;
  /** Legacy: X-Config-Write-Secret for scripts when JWT not used. */
  configWriteSecret?: string | null;
};

function edgeHeadersForConfigWrite(
  anonKey: string,
  opts?: PushRemoteOptions,
): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'apikey': anonKey,
  };
  const ut = opts?.userAccessToken?.trim();
  if (ut) {
    h['Authorization'] = `Bearer ${ut}`;
  } else {
    h['Authorization'] = `Bearer ${anonKey}`;
  }
  const sec = opts?.configWriteSecret?.trim();
  if (sec) {
    h['X-Config-Write-Secret'] = sec;
  }
  return h;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** fetch with AbortController; throws DOMException AbortError on timeout */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      cache: init.cache ?? 'no-store',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export type TestConnectionHintKey =
  | 'missing_field'
  | 'placeholder'
  | 'invalid_url'
  | 'key_too_short'
  | 'invalid_key_format'
  | 'unauthorized'
  | 'edge_not_found'
  | 'timeout'
  | 'network'
  | 'generic';

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  tableExists?: boolean;
  error?: string;
  hintKey?: TestConnectionHintKey;
}

function validateLocalCredentials(
  supabaseUrl: string,
  supabaseAnonKey: string,
): { ok: true } | { ok: false; hintKey: TestConnectionHintKey; error: string } {
  const url = supabaseUrl.trim();
  const key = supabaseAnonKey.trim();
  if (!url || !key) {
    return { ok: false, hintKey: 'missing_field', error: 'URL or anon key is empty' };
  }
  if (
    url.includes('your-supabase') ||
    key.includes('your-supabase') ||
    url === 'https://your-supabase-project.supabase.co' ||
    key === 'your-supabase-anon-key'
  ) {
    return { ok: false, hintKey: 'placeholder', error: 'Placeholder credentials' };
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, hintKey: 'invalid_url', error: 'Invalid URL' };
  }
  if (url.length < 20 || key.length < 20) {
    return { ok: false, hintKey: 'key_too_short', error: 'URL or anon key too short' };
  }
  // Supabase：旧版 anon 为 JWT；新版为 sb_publishable_…（非 JWT）
  if (!looksLikeSupabaseAnonKey(key)) {
    return {
      ok: false,
      hintKey: 'invalid_key_format',
      error:
        'Anon key must be legacy JWT (eyJ…) or new sb_publishable_… from Dashboard → API',
    };
  }
  return { ok: true };
}

/** 旧 JWT anon，或 Supabase 新版 publishable key */
function looksLikeSupabaseAnonKey(s: string): boolean {
  if (s.startsWith('sb_publishable_') && s.length >= 28) return true;
  const parts = s.split('.');
  if (parts.length === 3 && parts.every((p) => p.length > 0)) return true;
  return false;
}

function mapHttpToHint(status: number): TestConnectionHintKey {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'edge_not_found';
  return 'generic';
}

// ---- Public API ----

export interface RemoteConfigResult {
  config: Record<string, any>;
  version: number;
  updatedAt: string;
}

function chatContactLooksBound(c: HomePageConfig['chatContact'] | undefined): boolean {
  if (!c) return false;
  if (c.boundAt) return true;
  if (c.channelId && String(c.channelId).trim()) return true;
  if (c.merchantUserId && String(c.merchantUserId).trim()) return true;
  return false;
}

/**
 * 将配置还原为「出厂 defaultConfig」时，保留本机已填写、但不应因模板回滚而丢失的字段（若之前有非空值）。
 * - `backendProxyConfig.configWriteSecret`：推送到 `app_config` 时可能依赖；误清会导致无法推送直至重新填写。
 * 不处理：登录态（`agri_access_token`、Supabase `sb-*-auth-token` 等由 auth 层管理，与 `agri_home_config` 独立）。
 */
export function applyResetConfigWithPreservedLocalSecrets(
  nextFromDefaults: HomePageConfig,
  previous: HomePageConfig,
): HomePageConfig {
  const secret = previous.backendProxyConfig?.configWriteSecret;
  if (typeof secret === "string" && secret.trim() !== "") {
    return {
      ...nextFromDefaults,
      backendProxyConfig: {
        ...nextFromDefaults.backendProxyConfig,
        configWriteSecret: secret,
      },
    };
  }
  return nextFromDefaults;
}

/**
 * Apply remote `app_config` JSON over defaults, then restore device-local slices:
 * `userProfile`, bound `chatContact`, and `backendProxyConfig` (remote updates
 * URL/edge name; keys only present locally, e.g. configWriteSecret, remain).
 */
export function mergeRemoteAppConfigIntoLocal(
  defaultConfig: HomePageConfig,
  local: HomePageConfig,
  remotePayload: Record<string, unknown>,
): HomePageConfig {
  const fromRemote = deepMerge(
    defaultConfig as unknown as Record<string, unknown>,
    remotePayload,
    MERGE_REPLACE,
  ) as unknown as HomePageConfig;

  const keepChat = chatContactLooksBound(local.chatContact);
  const backendProxyConfig = deepMerge(
    local.backendProxyConfig as unknown as Record<string, unknown>,
    (fromRemote.backendProxyConfig ?? {}) as unknown as Record<string, unknown>,
    MERGE_REPLACE,
  ) as unknown as HomePageConfig['backendProxyConfig'];

  const base: HomePageConfig = {
    ...fromRemote,
    userProfile: local.userProfile,
    chatContact: keepChat ? local.chatContact : fromRemote.chatContact,
    backendProxyConfig,
  };

  // GET /config for non-admins omits cloudAIConfig.systemPrompt; deepMerge would otherwise
  // keep the default template from defaultConfig — remove so nothing sensitive stays in storage.
  const rpCloud = remotePayload.cloudAIConfig;
  if (
    rpCloud &&
    typeof rpCloud === 'object' &&
    !Array.isArray(rpCloud) &&
    !Object.prototype.hasOwnProperty.call(rpCloud, 'systemPrompt')
  ) {
    const bc = base.cloudAIConfig as Record<string, unknown> | undefined;
    if (bc && typeof bc === 'object') {
      delete bc.systemPrompt;
    }
  }

  if (isConfigCmsDirty()) {
    const merged = deepMerge(
      base as unknown as Record<string, unknown>,
      pickCmsOverlay(local) as unknown as Record<string, unknown>,
      MERGE_REPLACE,
    ) as unknown as HomePageConfig;
    const backendCms = pickLocalBackendCmsOverlay(local);
    if (Object.keys(backendCms).length > 0) {
      merged.backendProxyConfig = {
        ...(merged.backendProxyConfig ?? {}),
        ...backendCms,
      };
    }
    return merged;
  }

  return base;
}

/**
 * Fetch the remote config from Edge Function.
 * Returns null on any failure (network, not configured, etc.).
 */
export async function fetchRemoteConfig(
  supabaseUrl: string,
  supabaseAnonKey: string,
  edgeFunctionName: string = 'server',
  opts?: FetchRemoteConfigOptions,
): Promise<RemoteConfigResult | null> {
  if (!isSupabaseConfigured(supabaseUrl, supabaseAnonKey)) return null;

  try {
    const url = edgeFnUrl(supabaseUrl, edgeFunctionName, '/config');
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: edgeHeadersForConfigRead(supabaseAnonKey, opts),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn(TAG, 'fetch error:', res.status, errBody);
      return null;
    }

    const json = await res.json();

    // Edge Function returns { data: null } when no row exists
    if (json.data === null || (!json.config && !json.version)) {
      console.log(TAG, 'No remote config row found (first run?)');
      return null;
    }

    return {
      config: json.config as Record<string, any>,
      version: json.version as number,
      updatedAt: json.updatedAt as string,
    };
  } catch (err) {
    console.warn(TAG, 'fetch exception:', err);
    return null;
  }
}

export interface PushResult {
  success: boolean;
  newVersion: number;
  conflict?: boolean; // true if version mismatch
  /** Set when success is false (e.g. 401 missing write secret) */
  errorMessage?: string;
}

/**
 * Push config to remote via Edge Function with optimistic locking.
 *
 * @param expectedVersion  The version we last read. If the remote version
 *                         is different the write is rejected (conflict).
 *                         Pass `null` to force-write (skip version check).
 */
export async function pushRemoteConfig(
  supabaseUrl: string,
  supabaseAnonKey: string,
  config: Record<string, any>,
  expectedVersion: number | null,
  edgeFunctionName: string = 'server',
  pushOptions?: PushRemoteOptions,
): Promise<PushResult> {
  if (!isSupabaseConfigured(supabaseUrl, supabaseAnonKey)) {
    return { success: false, newVersion: 0 };
  }

  try {
    const url = edgeFnUrl(supabaseUrl, edgeFunctionName, '/config');
    const res = await fetch(url, {
      method: 'POST',
      headers: edgeHeadersForConfigWrite(supabaseAnonKey, pushOptions),
      body: JSON.stringify({
        config: stripSecretsFromConfigForRemote(config),
        expectedVersion,
      }),
    });

    const json = await res.json();

    if (res.status === 409 && json.conflict) {
      // Optimistic lock conflict
      console.warn(TAG, 'version conflict: expected', expectedVersion, 'got', json.currentVersion);
      return {
        success: false,
        newVersion: json.currentVersion ?? (expectedVersion ?? 0),
        conflict: true,
      };
    }

    if (!res.ok || !json.success) {
      const msg = json.error || res.statusText;
      console.warn(TAG, 'push error:', msg);
      return {
        success: false,
        newVersion: expectedVersion ?? 0,
        errorMessage: typeof msg === 'string' ? msg : undefined,
      };
    }

    console.log(TAG, 'push success, new version:', json.newVersion);
    return { success: true, newVersion: json.newVersion };
  } catch (err) {
    console.warn(TAG, 'push exception:', err);
    return { success: false, newVersion: expectedVersion ?? 0 };
  }
}

/**
 * PostgREST 会校验 anon / publishable key；无效（截断、乱编、非本项目）会返回明确错误。
 * 对 app_config 做一次 select：RLS 拒绝或表不存在仍说明「key 已被网关接受」，与无效 key 区分。
 */
function isInvalidAnonKeyPostgrestError(err: { message?: string; code?: string }): boolean {
  const code = String(err.code || '');
  const msg = (err.message || '').toLowerCase();

  if (code === 'PGRST301') return true;
  if (/invalid api key|double check your supabase.*anon|double check your supabase.*service_role/i.test(msg)) {
    return true;
  }
  if (/invalid jwt|jwt (could not be decoded|malformed|invalid)|malformed jwt|could not decode/i.test(msg)) {
    return true;
  }
  return false;
}

async function verifyAnonKeyAcceptedByPostgrest(
  supabaseUrl: string,
  anonKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, cache: 'no-store' }),
    },
  });

  const { error } = await supabase.from('app_config').select('id').limit(1);
  if (!error) return { ok: true };
  if (isInvalidAnonKeyPostgrestError(error)) {
    return {
      ok: false,
      reason: error.message || String((error as { code?: string }).code || ''),
    };
  }
  return { ok: true };
}

function isTaprootServerHealthJson(data: unknown): data is { status: string; version?: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { status?: string }).status === 'ok' &&
    typeof (data as { version?: string }).version === 'string'
  );
}

/**
 * Test connectivity to Supabase by calling the Edge Function health endpoint.
 * Returns structured hints for UI (hintKey) plus optional error detail.
 *
 * 1) PostgREST：对 app_config 做一次 select — 网关会校验 anon/publishable key（截断/乱编 → PGRST301 等）
 * 2) GET /functions/.../health — 校验响应 JSON 为 Taproot server，避免任意 200 HTML 误判成功
 * 3) GET /functions/.../config — 解析 body；仅当存在 config/version 行时才视为「表就绪」
 */
export async function testConnection(
  supabaseUrl: string,
  supabaseAnonKey: string,
  edgeFunctionName: string = 'server',
): Promise<TestConnectionResult> {
  const local = validateLocalCredentials(supabaseUrl, supabaseAnonKey);
  if (!local.ok) {
    return { ok: false, latencyMs: 0, error: local.error, hintKey: local.hintKey };
  }

  const base = supabaseUrl.trim();
  const anon = supabaseAnonKey.trim();
  const start = performance.now();
  try {
    // 0) Anon key 是否被该项目 PostgREST 接受（createClient + 真实表探测，避免仅靠 GET /rest/v1/ 误判）
    const keyProbe = await verifyAnonKeyAcceptedByPostgrest(base, anon);
    if (!keyProbe.ok) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - start),
        hintKey: 'unauthorized',
        error: keyProbe.reason.slice(0, 300),
      };
    }

    // 1) Health — 必须是 Taproot server 返回的 JSON，不能仅凭 HTTP 200
    const healthUrl = edgeFnUrl(base, edgeFunctionName, '/health');
    const healthRes = await fetchWithTimeout(healthUrl, {
      method: 'GET',
      headers: edgeHeaders(anon),
    });

    const latencyMs = Math.round(performance.now() - start);

    if (!healthRes.ok) {
      const errText = await healthRes.text();
      const hintKey = mapHttpToHint(healthRes.status);
      return {
        ok: false,
        latencyMs,
        hintKey,
        error: `HTTP ${healthRes.status}: ${errText.slice(0, 300)}`,
      };
    }

    let healthJson: unknown;
    try {
      healthJson = JSON.parse(await healthRes.text());
    } catch {
      return {
        ok: false,
        latencyMs,
        hintKey: 'generic',
        error:
          'Health response is not JSON — check Project URL (must be your Supabase project).',
      };
    }
    if (!isTaprootServerHealthJson(healthJson)) {
      return {
        ok: false,
        latencyMs,
        hintKey: 'edge_not_found',
        error:
          'Health JSON is not from TaprootAgro server Edge — deploy the server function or verify edgeFunctionName.',
      };
    }

    // 2) Config — 解析 body；200 + 非预期 JSON 不算成功
    const configUrl = edgeFnUrl(base, edgeFunctionName, '/config');
    const configRes = await fetchWithTimeout(configUrl, {
      method: 'GET',
      headers: edgeHeaders(anon),
    });

    if (!configRes.ok) {
      const errBody = await configRes.text();
      if (configRes.status === 401 || configRes.status === 403) {
        return {
          ok: false,
          latencyMs,
          hintKey: 'unauthorized',
          error: `HTTP ${configRes.status}: ${errBody.slice(0, 300)}`,
        };
      }
      if (configRes.status === 404) {
        return {
          ok: false,
          latencyMs,
          hintKey: 'edge_not_found',
          error: `HTTP 404: ${errBody.slice(0, 300)}`,
        };
      }
      if (
        errBody.includes('relation') ||
        errBody.includes('does not exist') ||
        errBody.includes('42P01')
      ) {
        return {
          ok: true,
          latencyMs,
          tableExists: false,
          error:
            'Connected, but table "app_config" not found. Please run 001_init.sql.',
        };
      }
      return {
        ok: true,
        latencyMs,
        tableExists: false,
        error: `Config probe failed: ${errBody.slice(0, 300)}`,
      };
    }

    let configJson: unknown;
    try {
      configJson = JSON.parse(await configRes.text());
    } catch {
      return {
        ok: false,
        latencyMs,
        hintKey: 'generic',
        error:
          'Config response is not JSON — check Edge deployment and function name.',
      };
    }

    const cj = configJson as Record<string, unknown>;
    if (cj && typeof cj.error === 'string' && !cj.config && cj.data === undefined) {
      return {
        ok: false,
        latencyMs,
        hintKey: 'generic',
        error: cj.error,
      };
    }

    if (cj?.data === null || (cj?.data === undefined && !cj?.version && !cj?.config)) {
      return {
        ok: true,
        latencyMs,
        tableExists: false,
        error:
          'Edge OK but no app_config row yet. Run migrations/001_init.sql or insert main row.',
      };
    }

    if (typeof cj?.version === 'number' || cj?.config !== undefined) {
      return { ok: true, latencyMs, tableExists: true };
    }

    return {
      ok: false,
      latencyMs,
      hintKey: 'generic',
      error: 'Unexpected /config JSON shape.',
    };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'AbortError') {
      return {
        ok: false,
        latencyMs,
        hintKey: 'timeout',
        error: 'Request timed out',
      };
    }
    const isNetwork =
      /failed to fetch|networkerror|load failed|ecconnrefused|enotfound/i.test(
        msg,
      );
    return {
      ok: false,
      latencyMs,
      hintKey: isNetwork ? 'network' : 'generic',
      error: msg,
    };
  }
}
