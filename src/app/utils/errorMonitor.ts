// ============================================================
// Lightweight Error Monitor
// Zero dependencies, works offline, optional remote reporting
// 新增：性能监控、Beacon API、版本跟踪、A/B测试集成
// ============================================================
// Usage:
//   import { errorMonitor } from '../utils/errorMonitor';
//   errorMonitor.install();          // Call once at app startup
//   errorMonitor.capture(error);     // Manual capture
//   errorMonitor.getLog();           // Get all stored errors
//   errorMonitor.flush();            // Send to remote endpoint
//   errorMonitor.clear();            // Clear stored errors
//   errorMonitor.trackVersionUsage('v3', 150); // Track API version
//   errorMonitor.trackWebSocketConnection('v3', true); // Track WS
// ============================================================

import type { ApiVersion } from './apiVersion';
import { storageGet, storageSet, storageRemove, storageGetJSON } from './safeStorage';

const LS_KEY = '__taproot_error_log__';
const LS_KEY_METRICS = '__taproot_metrics__';
const LS_DEVICE_ID = '__taproot_device_id__';
const MAX_ERRORS = 50;          // Max stored errors (FIFO)
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // Auto-clean after 7 days
const FLUSH_DEBOUNCE_MS = 5000; // Batch errors for 5s before sending

export interface ErrorEntry {
  id: string;
  timestamp: string;
  type: 'js' | 'unhandledrejection' | 'react' | 'network' | 'manual' | 'websocket';
  message: string;
  stack?: string;
  componentStack?: string;  // React error boundary stack
  url: string;
  userAgent: string;
  deviceId: string;
  apiVersion?: ApiVersion;  // 关联的API版本
  abTestGroup?: string;      // A/B测试分组
  meta?: Record<string, unknown>;
}

// 性能指标统计
export interface PerformanceMetrics {
  // 版本使用统计
  versionUsage: Record<ApiVersion, number>;
  
  // 版本降级次数
  fallbackCount: Record<ApiVersion, number>;
  
  // WebSocket连接统计
  wsConnections: {
    total: number;
    successful: number;
    failed: number;
    byVersion: Record<ApiVersion, number>;
  };
  
  // A/B测试分组统计
  abTestGroups: Record<string, number>;
  
  // 错误统计
  errorsByType: Record<string, number>;
  errorsByVersion: Record<ApiVersion, number>;
  
  // 响应时间统计
  avgResponseTime: number;
  p95ResponseTime: number;
  
  // 时间范围
  firstSeen: number;
  lastUpdate: number;
}

// Generate a stable device ID (persisted in localStorage)
function getDeviceId(): string {
  try {
    let id = storageGet(LS_DEVICE_ID);
    if (id) return id;
    // Simple fingerprint: random + timestamp
    id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    storageSet(LS_DEVICE_ID, id);
    return id;
  } catch {
    return 'dev_unknown';
  }
}

// Get the device ID (exported for gradual rollout use)
export function getStableDeviceId(): string {
  return getDeviceId();
}

class ErrorMonitor {
  private installed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reportEndpoint: string | null = null;
  private deviceId: string = '';
  private originalFetch: typeof window.fetch | null = null;
  private currentApiVersion: ApiVersion = 'v3';
  private currentAbTestGroup: string = '';
  private responseTimes: number[] = []; // 用于计算p95
  private customHeaders: Record<string, string> = {}; // 自定义请求头

  /**
   * Install global error handlers.
   * Call once at app startup (e.g., in main.tsx or Root.tsx).
   */
  install(options?: { 
    reportEndpoint?: string;
    apiVersion?: ApiVersion;
    abTestGroup?: string;
    headers?: Record<string, string>; // 自定义请求头（如 API Key）
  }) {
    if (this.installed) return;
    this.installed = true;
    this.deviceId = getDeviceId();
    this.reportEndpoint = options?.reportEndpoint || null;
    this.currentApiVersion = options?.apiVersion || 'v3';
    this.currentAbTestGroup = options?.abTestGroup || '';
    this.customHeaders = options?.headers || {};

    // Clean old errors on startup
    this.cleanOld();

    // Global JS errors
    window.addEventListener('error', (event) => {
      // Ignore errors from browser extensions
      if (event.filename && !event.filename.includes(location.origin)) return;

      this.addEntry({
        type: 'js',
        message: event.message || 'Unknown error',
        stack: event.error?.stack,
        url: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : location.href,
      });
    });

    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      this.addEntry({
        type: 'unhandledrejection',
        message: reason?.message || String(reason) || 'Unhandled promise rejection',
        stack: reason?.stack,
        url: location.href,
      });
    });

    // Network errors (fetch failures)
    const originalFetch = window.fetch;
    this.originalFetch = originalFetch;
    window.fetch = async (...args) => {
      const startTime = performance.now();
      try {
        const response = await originalFetch(...args);
        const responseTime = performance.now() - startTime;
        
        // Track 5xx server errors
        if (response.status >= 500) {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
          this.addEntry({
            type: 'network',
            message: `HTTP ${response.status} ${response.statusText}`,
            url,
            meta: { status: response.status, responseTime },
          });
        }
        
        // Track response time for successful requests
        if (response.ok) {
          this.trackResponseTime(responseTime);
        }
        
        return response;
      } catch (err: any) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
        this.addEntry({
          type: 'network',
          message: err?.message || 'Network request failed',
          url,
        });
        throw err;
      }
    };

    // Beacon API发送（页面关闭时）
    this.setupBeaconFlush();

    console.log('[ErrorMonitor] Installed, device:', this.deviceId);
  }

  /**
   * 设置Beacon API自动发送
   */
  private setupBeaconFlush() {
    const flushViaBeacon = () => {
      if (!this.reportEndpoint) return;
      
      const log = this.getLog();
      const metrics = this.getMetrics();
      
      if (log.length === 0 && !metrics.lastUpdate) return;
      
      const payload = JSON.stringify({
        deviceId: this.deviceId,
        appVersion: this.getAppVersion(),
        apiVersion: this.currentApiVersion,
        abTestGroup: this.currentAbTestGroup,
        errors: log,
        metrics,
        flushedAt: new Date().toISOString(),
      });
      
      // 使用Beacon API确保数据发送
      if ('sendBeacon' in navigator) {
        const blob = new Blob([payload], { type: 'application/json' });
        const sent = navigator.sendBeacon(this.reportEndpoint, blob);
        if (sent) {
          console.log('[ErrorMonitor] Beacon sent:', log.length, 'errors');
          // 发送成功后清除本地数据
          this.clear();
          this.clearMetrics();
        }
      } else {
        // 降级：使用fetch with keepalive
        fetch(this.reportEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {
          // Ignore errors in beacon fallback
        });
      }
    };
    
    // 页面隐藏时发送
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushViaBeacon();
      }
    });
    
    // 页面卸载前发送
    window.addEventListener('beforeunload', () => {
      flushViaBeacon();
    });
    
    // 移动端特殊处理：pagehide事件
    window.addEventListener('pagehide', () => {
      flushViaBeacon();
    });
  }

  /**
   * 设置当前API版本
   */
  setApiVersion(version: ApiVersion) {
    this.currentApiVersion = version;
  }

  /**
   * 设置当前A/B测试分组
   */
  setAbTestGroup(group: string) {
    this.currentAbTestGroup = group;
  }

  /**
   * 跟踪API版本使用
   */
  trackVersionUsage(version: ApiVersion, responseTime?: number) {
    const metrics = this.getMetrics();
    metrics.versionUsage[version] = (metrics.versionUsage[version] || 0) + 1;
    
    if (responseTime !== undefined) {
      this.trackResponseTime(responseTime);
    }
    
    metrics.lastUpdate = Date.now();
    this.saveMetrics(metrics);
  }

  /**
   * 跟踪版本降级
   */
  trackFallback(fromVersion: ApiVersion, toVersion: ApiVersion) {
    const metrics = this.getMetrics();
    metrics.fallbackCount[fromVersion] = (metrics.fallbackCount[fromVersion] || 0) + 1;
    metrics.lastUpdate = Date.now();
    this.saveMetrics(metrics);
    
    console.warn(`[ErrorMonitor] Version fallback: ${fromVersion} → ${toVersion}`);
  }

  /**
   * 跟踪WebSocket连接
   */
  trackWebSocketConnection(version: ApiVersion, success: boolean) {
    const metrics = this.getMetrics();
    metrics.wsConnections.total++;
    metrics.wsConnections.byVersion[version] = (metrics.wsConnections.byVersion[version] || 0) + 1;
    
    if (success) {
      metrics.wsConnections.successful++;
    } else {
      metrics.wsConnections.failed++;
    }
    
    metrics.lastUpdate = Date.now();
    this.saveMetrics(metrics);
  }

  /**
   * 跟踪WebSocket错误
   */
  trackWebSocketError(version: ApiVersion, error: Error) {
    this.addEntry({
      type: 'websocket',
      message: error.message,
      stack: error.stack,
      url: location.href,
      apiVersion: version,
    });
    
    const metrics = this.getMetrics();
    metrics.errorsByVersion[version] = (metrics.errorsByVersion[version] || 0) + 1;
    metrics.lastUpdate = Date.now();
    this.saveMetrics(metrics);
  }

  /**
   * 跟踪响应时间
   */
  private trackResponseTime(responseTime: number) {
    this.responseTimes.push(responseTime);
    
    // 限制数组大小，保留最近1000条
    if (this.responseTimes.length > 1000) {
      this.responseTimes = this.responseTimes.slice(-1000);
    }
    
    const metrics = this.getMetrics();
    
    // 计算平均响应时间
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    metrics.avgResponseTime = sum / this.responseTimes.length;
    
    // 计算P95
    const sorted = [...this.responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    metrics.p95ResponseTime = sorted[p95Index] || 0;
    
    this.saveMetrics(metrics);
  }

  /**
   * 获取性能指标
   */
  getMetrics(): PerformanceMetrics {
    try {
      const raw = storageGet(LS_KEY_METRICS);
      if (!raw) return this.createEmptyMetrics();
      
      const metrics = JSON.parse(raw);
      // 确保所有字段存在
      return {
        ...this.createEmptyMetrics(),
        ...metrics,
        wsConnections: {
          total: 0,
          successful: 0,
          failed: 0,
          byVersion: {},
          ...metrics.wsConnections,
        },
      };
    } catch {
      return this.createEmptyMetrics();
    }
  }

  /**
   * 创建空指标对象
   */
  private createEmptyMetrics(): PerformanceMetrics {
    return {
      versionUsage: {},
      fallbackCount: {},
      wsConnections: {
        total: 0,
        successful: 0,
        failed: 0,
        byVersion: {},
      },
      abTestGroups: {},
      errorsByType: {},
      errorsByVersion: {},
      avgResponseTime: 0,
      p95ResponseTime: 0,
      firstSeen: Date.now(),
      lastUpdate: 0,
    };
  }

  /**
   * 保存性能指标
   */
  private saveMetrics(metrics: PerformanceMetrics) {
    try {
      storageSet(LS_KEY_METRICS, JSON.stringify(metrics));
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * 清除性能指标
   */
  clearMetrics() {
    try {
      storageRemove(LS_KEY_METRICS);
      this.responseTimes = [];
      console.log('[ErrorMonitor] Metrics cleared');
    } catch { /* ignore */ }
  }

  /**
   * Manually capture an error (e.g., from React ErrorBoundary)
   */
  capture(error: Error | unknown, meta?: { 
    type?: ErrorEntry['type']; 
    componentStack?: string; 
    context?: string;
    apiVersion?: ApiVersion;
    abTestGroup?: string;
  }) {
    const err = error instanceof Error ? error : new Error(String(error));
    this.addEntry({
      type: meta?.type || 'manual',
      message: err.message,
      stack: err.stack,
      componentStack: meta?.componentStack,
      url: location.href,
      apiVersion: meta?.apiVersion || this.currentApiVersion,
      abTestGroup: meta?.abTestGroup || this.currentAbTestGroup,
      meta: meta?.context ? { context: meta.context } : undefined,
    });
  }

  /**
   * Get all stored error entries
   */
  getLog(): ErrorEntry[] {
    try {
      const raw = storageGet(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * Get error count
   */
  getCount(): number {
    return this.getLog().length;
  }

  /**
   * Get a summary of errors for display
   */
  getSummary(): { total: number; byType: Record<string, number>; last24h: number; lastError?: ErrorEntry } {
    const log = this.getLog();
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const byType: Record<string, number> = {};
    let last24h = 0;

    for (const entry of log) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      if (now - new Date(entry.timestamp).getTime() < day) last24h++;
    }

    return {
      total: log.length,
      byType,
      last24h,
      lastError: log[log.length - 1],
    };
  }

  /**
   * Clear all stored errors
   */
  clear() {
    try {
      storageRemove(LS_KEY);
      console.log('[ErrorMonitor] Log cleared');
    } catch { /* ignore */ }
  }

  /**
   * Set the remote reporting endpoint
   */
  setReportEndpoint(url: string | null) {
    this.reportEndpoint = url;
  }

  /**
   * Flush (send) errors to the remote endpoint
   * Returns true if successfully sent, false otherwise
   */
  async flush(): Promise<boolean> {
    if (!this.reportEndpoint) {
      console.log('[ErrorMonitor] No report endpoint configured, skipping flush');
      return false;
    }

    const log = this.getLog();
    const metrics = this.getMetrics();
    
    if (log.length === 0 && !metrics.lastUpdate) return true;

    // Use the original (unpatched) fetch to avoid recursive error capture
    const fetchFn = this.originalFetch || window.fetch;

    try {
      const response = await fetchFn(this.reportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.customHeaders },
        body: JSON.stringify({
          deviceId: this.deviceId,
          appVersion: this.getAppVersion(),
          apiVersion: this.currentApiVersion,
          abTestGroup: this.currentAbTestGroup,
          errors: log,
          metrics,
          flushedAt: new Date().toISOString(),
        }),
      });

      if (response.ok) {
        this.clear();
        this.clearMetrics();
        console.log(`[ErrorMonitor] Flushed ${log.length} errors and metrics to server`);
        return true;
      }
      console.warn(`[ErrorMonitor] Flush failed: HTTP ${response.status}`);
      return false;
    } catch (err: any) {
      console.warn('[ErrorMonitor] Flush failed:', err.message);
      return false;
    }
  }

  // ---- Internal ----

  private addEntry(partial: Omit<ErrorEntry, 'id' | 'timestamp' | 'userAgent' | 'deviceId'> & { url: string }) {
    const entry: ErrorEntry = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      deviceId: this.deviceId,
      apiVersion: this.currentApiVersion,
      abTestGroup: this.currentAbTestGroup,
      ...partial,
    };

    // Truncate long stacks to save space
    if (entry.stack && entry.stack.length > 2000) {
      entry.stack = entry.stack.slice(0, 2000) + '\n... (truncated)';
    }
    if (entry.componentStack && entry.componentStack.length > 1000) {
      entry.componentStack = entry.componentStack.slice(0, 1000) + '\n... (truncated)';
    }

    try {
      const log = this.getLog();
      log.push(entry);
      // FIFO: remove oldest if over limit
      while (log.length > MAX_ERRORS) log.shift();
      storageSet(LS_KEY, JSON.stringify(log));
    } catch {
      // localStorage full — try clearing old entries and retry
      try {
        storageSet(LS_KEY, JSON.stringify([entry]));
      } catch { /* truly out of space, give up */ }
    }

    // 更新错误统计
    const metrics = this.getMetrics();
    metrics.errorsByType[entry.type] = (metrics.errorsByType[entry.type] || 0) + 1;
    if (entry.apiVersion) {
      metrics.errorsByVersion[entry.apiVersion] = (metrics.errorsByVersion[entry.apiVersion] || 0) + 1;
    }
    if (entry.abTestGroup) {
      metrics.abTestGroups[entry.abTestGroup] = (metrics.abTestGroups[entry.abTestGroup] || 0) + 1;
    }
    metrics.lastUpdate = Date.now();
    this.saveMetrics(metrics);

    // Console log for dev visibility
    console.error(`[ErrorMonitor] Captured ${entry.type}:`, entry.message);

    // Schedule a debounced flush
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (!this.reportEndpoint) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private cleanOld() {
    try {
      const log = this.getLog();
      const cutoff = Date.now() - MAX_AGE_MS;
      const filtered = log.filter((e) => new Date(e.timestamp).getTime() > cutoff);
      if (filtered.length < log.length) {
        storageSet(LS_KEY, JSON.stringify(filtered));
        console.log(`[ErrorMonitor] Cleaned ${log.length - filtered.length} old entries`);
      }
    } catch { /* ignore */ }
  }

  private getAppVersion(): string {
    try {
      // Try to get version from SW
      const remoteConfig = storageGetJSON<{ version?: string }>('taproot_remote_config');
      return remoteConfig?.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

// Singleton instance
export const errorMonitor = new ErrorMonitor();