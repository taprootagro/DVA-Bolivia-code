// ============================================================================
// Unified API Client - 统一API客户端
// ============================================================================
// 整合版本管理、错误重试、离线缓存、网络质量感知的API调用封装。
//
// 核心功能：
//   1. 自动版本协商与降级
//   2. 指数退避重试（网络错误、超时）
//   3. 离线缓存fallback（IndexedDB）
//   4. 网络质量感知（2G/3G降级）
//   5. 请求去重（防止重复调用）
//   6. 超时控制（低端设备适配）
//
// 使用场景：
//   - 替代所有直接的 fetch() 调用
//   - Supabase Edge Function API
//   - 远程配置、翻译包、AI服务
// ============================================================================

import type { ApiCallOptions, VersionedResponse, ApiVersion, VersionedRequest } from './apiVersion';
import { apiCallWithVersion } from './apiVersion';
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';

// ============================================================================
// IndexedDB缓存
// ============================================================================

interface ApiCacheSchema extends DBSchema {
  'api-cache': {
    key: string;
    value: {
      url: string;
      data: unknown;
      version: ApiVersion;
      timestamp: number;
      expiresAt: number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<ApiCacheSchema>> | null = null;

function getDB(): Promise<IDBPDatabase<ApiCacheSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ApiCacheSchema>('taproot-api-cache', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('api-cache')) {
          db.createObjectStore('api-cache');
        }
      },
    });
  }
  return dbPromise;
}

async function getCachedResponse(url: string): Promise<{ data: unknown; version: ApiVersion } | null> {
  try {
    const db = await getDB();
    const cached = await db.get('api-cache', url);
    if (!cached) return null;

    // 检查是否过期
    if (Date.now() > cached.expiresAt) {
      await db.delete('api-cache', url);
      return null;
    }

    return { data: cached.data, version: cached.version };
  } catch {
    return null;
  }
}

async function setCachedResponse(
  url: string,
  data: unknown,
  version: ApiVersion,
  ttlMs: number = 5 * 60 * 1000 // 默认5分钟
): Promise<void> {
  try {
    const db = await getDB();
    await db.put('api-cache', {
      url,
      data,
      version,
      timestamp: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });
  } catch (error) {
    console.warn('[ApiClient] 缓存写入失败:', error);
  }
}

// ============================================================================
// 请求去重（飞行中请求）
// ============================================================================

const inflightRequests = new Map<string, Promise<VersionedResponse<unknown>>>();

function getRequestKey(endpoint: string, method: string, body?: unknown): string {
  const bodyKey = body ? JSON.stringify(body) : '';
  return `${method}:${endpoint}:${bodyKey}`;
}

// ============================================================================
// 网络质量检测
// ============================================================================

function getNetworkQuality(): 'high' | 'medium' | 'low' {
  if (typeof navigator === 'undefined' || !('connection' in navigator)) {
    return 'medium';
  }

  const conn = (navigator as any).connection;
  const effectiveType = conn?.effectiveType || '4g';

  if (effectiveType === '4g' || effectiveType === 'wifi') return 'high';
  if (effectiveType === '3g') return 'medium';
  return 'low'; // 2g, slow-2g
}

function getNetworkTimeout(): number {
  const quality = getNetworkQuality();
  switch (quality) {
    case 'high': return 10000; // 10s
    case 'medium': return 20000; // 20s
    case 'low': return 30000; // 30s
    default: return 15000;
  }
}

// ============================================================================
// 超时控��
// ============================================================================

function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(url, options)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// ============================================================================
// 重试策略
// ============================================================================

interface RetryOptions {
  /** 最大重试次数 */
  maxRetries?: number;
  
  /** 初始延迟（ms）*/
  initialDelay?: number;
  
  /** 指数退避倍数 */
  backoffMultiplier?: number;
  
  /** 最大延迟（ms）*/
  maxDelay?: number;
  
  /** 哪些HTTP状态码需要重试 */
  retryableStatusCodes?: number[];
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 10000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error: unknown, statusCode?: number, retryOptions?: RetryOptions): boolean {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  
  // 网络错误总是重试
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  
  // 超时错误重试
  if (error instanceof Error && error.message.includes('timeout')) {
    return true;
  }
  
  // HTTP状态码重试
  if (statusCode && opts.retryableStatusCodes.includes(statusCode)) {
    return true;
  }
  
  return false;
}

// ============================================================================
// 统一API客户端
// ============================================================================

export interface ApiClientOptions<T = unknown> extends Omit<ApiCallOptions<T>, 'fetchFn'> {
  /** 超时时间（ms，自动根据网络质量调整）*/
  timeout?: number;
  
  /** 重试选项 */
  retry?: RetryOptions;
  
  /** 是否启用缓存 */
  cache?: boolean;
  
  /** 缓存TTL（ms）*/
  cacheTTL?: number;
  
  /** 离线时是否使用缓存（即使过期）*/
  offlineFallback?: boolean;
  
  /** 请求去重 */
  deduplicate?: boolean;
}

/**
 * 统一API客户端 - 带版本管理、重试、缓存
 * 
 * @example
 * ```ts
 * // 基础用法
 * const { data } = await apiClient({
 *   endpoint: 'https://api.taprootagro.com/config',
 *   method: 'GET',
 *   preferredVersion: 'v3',
 *   enableFallback: true,
 * });
 * 
 * // 带缓存和重试
 * const { data } = await apiClient({
 *   endpoint: '/api/remote-config',
 *   cache: true,
 *   cacheTTL: 10 * 60 * 1000, // 10分钟
 *   retry: { maxRetries: 3 },
 *   offlineFallback: true, // 离线时使用过期缓存
 * });
 * ```
 */
export async function apiClient<T = unknown>(
  options: ApiClientOptions<T>
): Promise<VersionedResponse<T>> {
  const {
    endpoint,
    method = 'GET',
    body,
    headers = {},
    timeout,
    retry: retryOptions,
    cache = false,
    cacheTTL = 5 * 60 * 1000,
    offlineFallback = false,
    deduplicate = true,
    ...versionOptions
  } = options;

  // 请求去重
  const requestKey = getRequestKey(endpoint, method, body);
  if (deduplicate && method === 'GET') {
    const inflight = inflightRequests.get(requestKey);
    if (inflight) {
      console.log(`[ApiClient] 复用飞行中请求: ${endpoint}`);
      return inflight as Promise<VersionedResponse<T>>;
    }
  }

  // 尝试从缓存读取（仅GET）
  if (cache && method === 'GET') {
    const cached = await getCachedResponse(endpoint);
    if (cached) {
      console.log(`[ApiClient] 缓存命中: ${endpoint} (version: ${cached.version})`);
      return {
        data: cached.data as T,
        apiVersion: cached.version,
        timestamp: Date.now(),
        fallback: false,
      };
    }
  }

  // 构建请求Promise
  const requestPromise = executeWithRetry<T>({
    endpoint,
    method,
    body,
    headers,
    timeout: timeout || getNetworkTimeout(),
    retryOptions,
    versionOptions,
    cache,
    cacheTTL,
    offlineFallback,
  });

  // 保存飞行中请求
  if (deduplicate && method === 'GET') {
    inflightRequests.set(requestKey, requestPromise as Promise<VersionedResponse<unknown>>);
    requestPromise.finally(() => {
      inflightRequests.delete(requestKey);
    });
  }

  return requestPromise;
}

/**
 * 带重试的执行器
 */
async function executeWithRetry<T>(
  params: {
    endpoint: string;
    method: string;
    body?: VersionedRequest;
    headers: Record<string, string>;
    timeout: number;
    retryOptions?: RetryOptions;
    versionOptions: Omit<ApiCallOptions, 'endpoint' | 'method' | 'body' | 'headers' | 'fetchFn'>;
    cache: boolean;
    cacheTTL: number;
    offlineFallback: boolean;
  }
): Promise<VersionedResponse<T>> {
  const { endpoint, method, body, headers, timeout, retryOptions, versionOptions, cache, cacheTTL, offlineFallback } = params;
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };

  let lastError: Error | null = null;
  let statusCode: number | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // 自定义fetch函数（注入超时控制）
      const customFetch = (url: string, init?: RequestInit) => {
        return fetchWithTimeout(url, init || {}, timeout);
      };

      // 调用版本管理API
      const response = await apiCallWithVersion<T>({
        endpoint,
        method: method as 'GET' | 'POST',
        body,
        headers,
        fetchFn: customFetch,
        ...versionOptions,
      });

      // 成功：写入缓存
      if (cache && method === 'GET') {
        await setCachedResponse(endpoint, response.data, response.apiVersion, cacheTTL);
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      
      // 检查是否需要重试
      if (!shouldRetry(error, statusCode, retryOptions)) {
        break; // 不可重试的错误，立即抛出
      }

      if (attempt < opts.maxRetries) {
        // 计算延迟（指数退避）
        const delay = Math.min(
          opts.initialDelay * Math.pow(opts.backoffMultiplier, attempt),
          opts.maxDelay
        );
        console.warn(`[ApiClient] 重试 ${attempt + 1}/${opts.maxRetries}，延迟 ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  // 所有重试失败：尝试离线缓存fallback
  if (offlineFallback && method === 'GET') {
    console.warn('[ApiClient] 所有重试失败，尝试离线缓存...');
    const cached = await getCachedResponse(endpoint);
    if (cached) {
      console.log(`[ApiClient] 使用过期缓存: ${endpoint}`);
      return {
        data: cached.data as T,
        apiVersion: cached.version,
        timestamp: Date.now(),
        fallback: true,
      };
    }
  }

  // 彻底失败
  throw new Error(
    `API请求失败 (${opts.maxRetries}次重试后): ${lastError?.message || 'Unknown error'}`
  );
}

// ============================================================================
// 便捷方法
// ============================================================================

/**
 * GET请求（默认启用缓存）
 */
export async function apiGet<T = unknown>(
  endpoint: string,
  options: Omit<ApiClientOptions<T>, 'endpoint' | 'method'> = {}
): Promise<T> {
  const response = await apiClient<T>({
    endpoint,
    method: 'GET',
    cache: true,
    offlineFallback: true,
    ...options,
  });
  return response.data;
}

/**
 * POST请求（默认禁用缓存）
 */
export async function apiPost<T = unknown>(
  endpoint: string,
  body: VersionedRequest,
  options: Omit<ApiClientOptions<T>, 'endpoint' | 'method' | 'body'> = {}
): Promise<T> {
  const response = await apiClient<T>({
    endpoint,
    method: 'POST',
    body,
    cache: false,
    ...options,
  });
  return response.data;
}

/**
 * 清除指定endpoint的缓存
 */
export async function clearCache(endpoint?: string): Promise<void> {
  try {
    const db = await getDB();
    if (endpoint) {
      await db.delete('api-cache', endpoint);
      console.log(`[ApiClient] 缓存已清除: ${endpoint}`);
    } else {
      await db.clear('api-cache');
      console.log('[ApiClient] 所有缓存已清除');
    }
  } catch (error) {
    console.error('[ApiClient] 缓存清除失败:', error);
  }
}

/**
 * 获取缓存统计信息
 */
export async function getCacheStats(): Promise<{ count: number; entries: string[] }> {
  try {
    const db = await getDB();
    const keys = await db.getAllKeys('api-cache');
    return {
      count: keys.length,
      entries: keys as string[],
    };
  } catch {
    return { count: 0, entries: [] };
  }
}