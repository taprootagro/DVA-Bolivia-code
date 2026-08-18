// ============================================================================
// API Version Management - API版本兼容与降级系统
// ============================================================================
// 面向全球低端设备用户的韧性优化，支持自动版本协商、降级和响应转换。
//
// 核心功能：
//   1. 版本协商：客户端声明支持的版本，服务端返回可用版本
//   2. 自动降级：v3 → v2 → v1 fallback链
//   3. 响应转换：旧版本格式自动转换为新版本schema
//   4. 离线缓存：最后成功版本持久化
//   5. 错误重试：版本不匹配时自动降级重试
//
// 使用场景：
//   - Supabase Edge Function API升级后，旧客户端仍能工作
//   - 远程配置服务版本变更时的平滑过渡
//   - 第三方API (ChatProxy, CloudAI) 版本管理
// ============================================================================

import { deepMerge } from './deepMerge';
import { storageGetJSON, storageSetJSON } from './safeStorage';

// ============================================================================
// 类型定义
// ============================================================================

export type ApiVersion = 'v1' | 'v2' | 'v3';

export interface ApiVersionInfo {
  /** API版本号 */
  version: ApiVersion;
  
  /** 是否为当前推荐版本 */
  current: boolean;
  
  /** 是否已废弃 */
  deprecated: boolean;
  
  /** 废弃截止日期（ISO 8601） */
  deprecationDate?: string;
  
  /** 兼容的客户端版本范围 */
  compatibleClientVersions?: string[];
}

export interface ApiVersionResponse {
  /** 实际使用的API版本 */
  apiVersion: ApiVersion;
  
  /** 服务端支持的所有版本 */
  supportedVersions?: ApiVersion[];
  
  /** 是否为降级响应 */
  fallback?: boolean;
  
  /** 原始请求的版本 */
  requestedVersion?: ApiVersion;
}

export interface VersionedRequest {
  /** 客户端期望的API版本 */
  apiVersion?: ApiVersion;
  
  /** 客户端支持的版本列表（降级用）*/
  supportedVersions?: ApiVersion[];
  
  /** 其他请求参数 */
  [key: string]: unknown;
}

export interface VersionedResponse<T = unknown> extends ApiVersionResponse {
  /** 响应数据 */
  data: T;
  
  /** 响应时间戳 */
  timestamp: number;
  
  /** 是否已转换格式 */
  transformed?: boolean;
}

// ============================================================================
// 版本转换器注册表
// ============================================================================

type Transformer<T = unknown> = (data: unknown, fromVersion: ApiVersion, toVersion: ApiVersion) => T;

const transformers = new Map<string, Transformer>();

/**
 * 注册版本转换器
 * 
 * @param endpoint - API端点（如 '/api/config', '/server/token'）
 * @param fromVersion - 源版本
 * @param toVersion - 目标版本
 * @param transformer - 转换函数
 * 
 * @example
 * ```ts
 * registerTransformer('/api/config', 'v1', 'v2', (data) => {
 *   return {
 *     ...data,
 *     features: data.featureFlags || {}, // v1字段重命名
 *   };
 * });
 * ```
 */
export function registerTransformer<T = unknown>(
  endpoint: string,
  fromVersion: ApiVersion,
  toVersion: ApiVersion,
  transformer: Transformer<T>
): void {
  const key = `${endpoint}:${fromVersion}->${toVersion}`;
  transformers.set(key, transformer);
}

/**
 * 应用版本转换
 */
function applyTransform<T = unknown>(
  endpoint: string,
  data: unknown,
  fromVersion: ApiVersion,
  toVersion: ApiVersion
): T {
  const key = `${endpoint}:${fromVersion}->${toVersion}`;
  const transformer = transformers.get(key);
  
  if (transformer) {
    return transformer(data, fromVersion, toVersion) as T;
  }
  
  // 无转换器，直接返回原数据
  return data as T;
}

// ============================================================================
// 版本策略管理
// ============================================================================

const VERSION_ORDER: ApiVersion[] = ['v3', 'v2', 'v1'];

const LS_KEY_LAST_SUCCESS = 'taproot_api_last_success_version';

/**
 * 获取版本降级链
 * 
 * @param preferredVersion - 首选版本
 * @returns 降级顺序数组 [v3, v2, v1] 或 [v2, v1]
 */
export function getVersionFallbackChain(preferredVersion: ApiVersion = 'v3'): ApiVersion[] {
  const idx = VERSION_ORDER.indexOf(preferredVersion);
  if (idx === -1) return VERSION_ORDER;
  return VERSION_ORDER.slice(idx);
}

/**
 * 保存最后成功的API版本（离线恢复用）
 */
export function saveLastSuccessVersion(endpoint: string, version: ApiVersion): void {
  try {
    const data = storageGetJSON<Record<string, { version: ApiVersion; timestamp: number }>>(LS_KEY_LAST_SUCCESS, {}) || {};
    data[endpoint] = { version, timestamp: Date.now() };
    storageSetJSON(LS_KEY_LAST_SUCCESS, data);
  } catch {
    // Ignore
  }
}

/**
 * 获取最后成功的API版本
 */
export function getLastSuccessVersion(endpoint: string): ApiVersion | null {
  try {
    const data = storageGetJSON<Record<string, { version: ApiVersion; timestamp: number }>>(LS_KEY_LAST_SUCCESS, {}) || {};
    const record = data[endpoint];
    if (!record) return null;
    
    // 超过7天的记录视为过期
    const age = Date.now() - record.timestamp;
    if (age > 7 * 24 * 60 * 60 * 1000) return null;
    
    return record.version;
  } catch {
    return null;
  }
}

/**
 * 获取智首选版本（优先使用最后成功版本）
 */
export function getPreferredVersion(endpoint: string, defaultVersion: ApiVersion = 'v3'): ApiVersion {
  return getLastSuccessVersion(endpoint) || defaultVersion;
}

// ============================================================================
// 版本协商与降级重试
// ============================================================================

export interface ApiCallOptions<T = unknown> {
  /** API端点 */
  endpoint: string;
  
  /** 请求方法 */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  
  /** 请求体 */
  body?: VersionedRequest;
  
  /** 请求头 */
  headers?: Record<string, string>;
  
  /** 首选版本 */
  preferredVersion?: ApiVersion;
  
  /** 是否启用自动降级 */
  enableFallback?: boolean;
  
  /** 自定义fetch函数（可注入mock） */
  fetchFn?: typeof fetch;
  
  /** 响应验证函数（返回false触发降级）*/
  validateResponse?: (data: unknown, version: ApiVersion) => boolean;
  
  /** 自动转换到目标版本 */
  transformTo?: ApiVersion;
}

/**
 * 带版本管理的API调用
 * 
 * @returns Promise<VersionedResponse<T>>
 * 
 * @example
 * ```ts
 * const response = await apiCallWithVersion({
 *   endpoint: '/api/remote-config',
 *   method: 'GET',
 *   preferredVersion: 'v3',
 *   enableFallback: true,
 *   validateResponse: (data) => !!data.version,
 * });
 * 
 * if (response.fallback) {
 *   console.warn(`使用降级版本: ${response.apiVersion}`);
 * }
 * ```
 */
export async function apiCallWithVersion<T = unknown>(
  options: ApiCallOptions<T>
): Promise<VersionedResponse<T>> {
  const {
    endpoint,
    method = 'GET',
    body,
    headers = {},
    preferredVersion,
    enableFallback = true,
    fetchFn = fetch,
    validateResponse,
    transformTo,
  } = options;

  // 智能获取首选版本（优先使用历史成功版本）
  const targetVersion = preferredVersion || getPreferredVersion(endpoint, 'v3');
  const fallbackChain = enableFallback ? getVersionFallbackChain(targetVersion) : [targetVersion];

  let lastError: Error | null = null;

  for (const version of fallbackChain) {
    try {
      // 构建请求
      const requestBody = body ? {
        ...body,
        apiVersion: version,
        supportedVersions: fallbackChain,
      } : undefined;

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-API-Version': version,
        'X-Client-Supported-Versions': fallbackChain.join(','),
        ...headers,
      };

      // 发起请求
      const response = await fetchFn(endpoint, {
        method,
        headers: requestHeaders,
        body: requestBody ? JSON.stringify(requestBody) : undefined,
      });

      if (!response.ok) {
        // HTTP错误，尝试下一个版本
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        continue;
      }

      // 解析响应
      const responseData = await response.json();
      const responseVersion = (response.headers.get('X-API-Version') || version) as ApiVersion;

      // 验证响应
      if (validateResponse && !validateResponse(responseData, responseVersion)) {
        lastError = new Error(`Response validation failed for version ${responseVersion}`);
        continue;
      }

      // 转换到目标版本格式
      let finalData = responseData;
      let transformed = false;
      
      if (transformTo && transformTo !== responseVersion) {
        finalData = applyTransform(endpoint, responseData, responseVersion, transformTo);
        transformed = true;
      }

      // 保存成功版本
      saveLastSuccessVersion(endpoint, responseVersion);

      return {
        data: finalData,
        apiVersion: responseVersion,
        supportedVersions: fallbackChain,
        fallback: version !== targetVersion,
        requestedVersion: targetVersion,
        timestamp: Date.now(),
        transformed,
      };
    } catch (error) {
      lastError = error as Error;
      console.warn(`[ApiVersion] ${version} failed:`, lastError.message);
      // 继续尝试下一个版本
    }
  }

  // 所有版本都失败
  throw new Error(
    `API call failed for all versions (${fallbackChain.join(', ')}). Last error: ${lastError?.message || 'Unknown'}`
  );
}

// ============================================================================
// 预定义转换器 - Remote Config
// ============================================================================

/**
 * v1 → v2 转换器：Remote Config
 * v1: 使用 featureFlags 字段
 * v2: 重命名为 features 字段
 */
registerTransformer('/api/remote-config', 'v1', 'v2', (data: any) => {
  return {
    ...data,
    features: data.featureFlags || data.features || {},
  };
});

/**
 * v2 → v3 转换器：Remote Config
 * v3: 新增 metadata 字段，包含版本信息
 */
registerTransformer('/api/remote-config', 'v2', 'v3', (data: any) => {
  return {
    ...data,
    metadata: {
      apiVersion: 'v3',
      fetchedAt: Date.now(),
      ...data.metadata,
    },
  };
});

// ============================================================================
// 预定义转换器 - Chat Proxy
// ============================================================================

/**
 * v1 → v2 转换器：Chat Token
 * v1: 返回 { token, appKey }
 * v2: 返回 { token, appId, uid }
 */
registerTransformer('/server/token', 'v1', 'v2', (data: any) => {
  return {
    token: data.token,
    appId: data.appKey || data.appId || '',
    uid: data.userId || data.uid || '',
  };
});

/**
 * v1 → v2 转换器：Chat Messages
 * v1: 时间戳为秒级
 * v2: 时间戳为毫秒级
 */
registerTransformer('/server/poll', 'v1', 'v2', (data: any) => {
  const messages = data.messages || [];
  return {
    ...data,
    messages: messages.map((msg: any) => ({
      ...msg,
      timestamp: msg.timestamp < 10000000000 ? msg.timestamp * 1000 : msg.timestamp,
    })),
  };
});

// ============================================================================
// 便捷API：配置merge + 版本管理
// ============================================================================

/**
 * 获取远程配置（带版本管理和深度merge）
 * 
 * @param configUrl - 配置URL
 * @param localDefaults - 本地默认配置
 * @param options - API调用选项
 * @returns 合并后的配置
 * 
 * @example
 * ```ts
 * const config = await fetchConfigWithVersion(
 *   'https://api.taprootagro.com/config',
 *   DEFAULT_CONFIG,
 *   { enableFallback: true, preferredVersion: 'v3' }
 * );
 * ```
 */
export async function fetchConfigWithVersion<T extends Record<string, unknown>>(
  configUrl: string,
  localDefaults: T,
  options: Omit<ApiCallOptions, 'endpoint' | 'method'> = {}
): Promise<T> {
  try {
    const response = await apiCallWithVersion<Partial<T>>({
      endpoint: configUrl,
      method: 'GET',
      enableFallback: true,
      transformTo: 'v3',
      ...options,
    });

    // 深度合并远程配置与本地默认值
    const merged = deepMerge(localDefaults, response.data, {
      arrayStrategy: 'replace', // 远程配置完全覆盖本地数组
      clone: true,
    });

    if (response.fallback) {
      console.warn(`[Config] 使用降级版本 ${response.apiVersion} (期望 ${response.requestedVersion})`);
    }

    return merged;
  } catch (error) {
    console.error('[Config] 远程配置获取失败，使用本地默认值:', error);
    return localDefaults;
  }
}

/**
 * 批量获取配置（并行，最快响应优先）
 * 
 * @param configUrls - 配置URL数组（主备）
 * @param localDefaults - 本地默认配置
 * @returns 第一个成功的配置
 */
export async function fetchConfigWithFallbackUrls<T extends Record<string, unknown>>(
  configUrls: string[],
  localDefaults: T
): Promise<T> {
  const promises = configUrls.map((url) =>
    fetchConfigWithVersion(url, localDefaults, { enableFallback: true })
  );

  try {
    // Promise.race: 第一个成功的返回
    return await Promise.race(promises);
  } catch (error) {
    console.error('[Config] 所有配置源均失败，使用本地默认值:', error);
    return localDefaults;
  }
}