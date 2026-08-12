// ============================================================
// Silent Recovery — L2 全局错误静默处理 + L4 僵尸页面恢复
//
// 目标：农民用户永远看不到崩溃
// 策略：
//   L2 — 拦截 event handler / async 中的 JS 错误，非致命的静默吞掉
//   L4 — PWA 从后台恢复时检测僵尸状态，自动 reload
//
// 在 Root.tsx 中调用 installSilentRecovery() 即可
// ============================================================

import { errorMonitor } from './errorMonitor';
import { clearRecoveryCounters, isChunkLoadError } from './versionRecovery';

const FATAL_RELOAD_KEY = '__taproot_fatal_reload__';
const FATAL_RELOAD_MAX = 2;
const FATAL_RELOAD_WINDOW_MS = 30_000; // 30秒内最多reload 2次

/**
 * 判断错误是否致命（会导致白屏/功能完全不可用）
 * 非致命错误：静默吞掉，不打扰用户
 * 致命错误：尝试 reload
 */
function isFatalError(error: Error | string): boolean {
  const msg = typeof error === 'string' ? error : (error.message || '');
  const fatalPatterns = [
    // React 内部崩溃
    'Minified React error',
    // 路由崩溃
    'No routes matched',
    // 内存溢出
    'out of memory',
    'Maximum call stack',
  ];
  return fatalPatterns.some(p => msg.includes(p));
}

/**
 * 判断错误是否可以安全忽略（浏览器扩展、第三方脚本等）
 */
function isSafeToIgnore(event: ErrorEvent): boolean {
  // 非本站脚本的错误
  if (event.filename && !event.filename.includes(location.origin)) return true;
  // ResizeObserver 错误 — 浏览器已知的无害错误
  if (event.message?.includes('ResizeObserver')) return true;
  // WebSocket 关闭（网络波动）
  if (event.message?.includes('WebSocket')) return true;
  // Service Worker 注册失败（不影响主应用）
  if (event.message?.includes('ServiceWorker')) return true;
  return false;
}

/**
 * 尝试致命错误 reload — 带频率保护
 */
function attemptFatalReload(): boolean {
  try {
    const raw = sessionStorage.getItem(FATAL_RELOAD_KEY);
    const data = raw ? JSON.parse(raw) : { count: 0, firstTime: Date.now() };

    // 超过窗口期，重置计数
    if (Date.now() - data.firstTime > FATAL_RELOAD_WINDOW_MS) {
      data.count = 0;
      data.firstTime = Date.now();
    }

    if (data.count >= FATAL_RELOAD_MAX) {
      // 短时间内已 reload 过多次，放弃（避免无限循环）
      return false;
    }

    data.count++;
    sessionStorage.setItem(FATAL_RELOAD_KEY, JSON.stringify(data));

    // 延迟 reload 让错误日志有时间写入
    setTimeout(() => window.location.reload(), 500);
    return true;
  } catch {
    return false;
  }
}

/**
 * L5: 内存溢出预警与自动清理 (针对 Chrome/Android WebView)
 */
function installMemoryMonitor() {
  if (!performance || !('memory' in performance)) return;

  setInterval(() => {
    try {
      const memory = (performance as any).memory;
      const jsHeapUsedMB = Math.round(memory.usedJSHeapSize / 1048576);
      
      // Warning threshold: 400MB
      if (jsHeapUsedMB > 400) {
        console.warn(`[SilentRecovery] High memory usage: ${jsHeapUsedMB}MB`);
        errorMonitor.capture(new Error('High memory usage warning'), {
          type: 'js',
          context: `Heap used: ${jsHeapUsedMB}MB`,
        });
      }

      // Critical threshold: 800MB (OOM imminent on low-end devices)
      if (jsHeapUsedMB > 800) {
        console.error(`[SilentRecovery] Critical memory usage (${jsHeapUsedMB}MB), forcing reload to prevent crash...`);
        attemptFatalReload();
      }
    } catch { /* ignore */ }
  }, 30000); // Check every 30 seconds
}

/**
 * L4: 僵尸页面检测
 * PWA 从后台恢复时，React 树可能已经被 OS 销毁
 * 检测 DOM 是否完整，不完整则静默 reload
 */
function installZombieDetector() {
  const pageLoadedAt = Date.now();
  const GRACE_MS = 5000;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - pageLoadedAt < GRACE_MS) return;

    // 延迟检测：给 React 100ms 时间恢复渲染
    setTimeout(() => {
      const root = document.getElementById('root');
      if (!root) return;

      // ErrorBoundary 恢复 UI 可见时不 reload
      if (root.querySelector('button')) return;

      // 检测1：root 下没有子节点 → 白屏
      if (root.childElementCount === 0) {
        console.warn('[SilentRecovery] Zombie detected: empty root, reloading...');
        errorMonitor.capture(new Error('Zombie page: empty root after visibility restore'), {
          type: 'js',
          context: 'ZombieDetector',
        });
        window.location.reload();
        return;
      }

      // 检测2：body 高度异常且仍在 loading
      if (document.readyState !== 'complete' && root.offsetHeight < 50) {
        console.warn('[SilentRecovery] Zombie detected: tiny root height while loading, reloading...');
        errorMonitor.capture(new Error('Zombie page: root height < 50px while loading'), {
          type: 'js',
          context: 'ZombieDetector',
        });
        window.location.reload();
      }
    }, 200);
  });
}

/**
 * 安装全局静默恢复系统
 * 在 Root.tsx 的 useEffect 中调用一次即可
 */
let installed = false;

export function installSilentRecovery() {
  if (installed) return;
  installed = true;

  // ---- L2: 全局 JS 错误拦截 ----
  window.addEventListener('error', (event: ErrorEvent) => {
    // 安全忽略的错误：完全吞掉
    if (isSafeToIgnore(event)) {
      event.preventDefault();
      return;
    }

    // errorMonitor 已经在记录了（它的 install() 先执行）
    // 这里只负责决定是否需要恢复动作

    if (event.error && isFatalError(event.error)) {
      console.warn('[SilentRecovery] Fatal error detected, attempting reload...');
      // 不 preventDefault — 让 errorMonitor 也能捕获
      attemptFatalReload();
    } else {
      // 非致命错误：阻止默认行为（防止控制台红色报错吓到开发者之外的人）
      // 但在 dev 环境保留
      if (import.meta.env.PROD) {
        event.preventDefault();
      }
    }
  }, true); // capture phase — 比 errorMonitor 的 listener 更早

  // ---- L2: 未处理的 Promise rejection ----
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;

    // Chunk 错配由 main.tsx / versionRecovery 专门处理
    if (isChunkLoadError(reason)) {
      event.preventDefault();
      return;
    }

    const msg = reason?.message || String(reason) || '';

    // 网络请求失败 → 静默（网络波动很常见）
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch') || msg.includes('Load failed')) {
      if (import.meta.env.PROD) {
        event.preventDefault();
      }
      return;
    }

    // 致命错误 → reload
    if (reason instanceof Error && isFatalError(reason)) {
      console.warn('[SilentRecovery] Fatal rejection, attempting reload...');
      attemptFatalReload();
      return;
    }

    // 其他 → 静默吞掉（生产环境）
    if (import.meta.env.PROD) {
      event.preventDefault();
    }
  });

  // ---- L4: 僵尸页面恢复 ----
  installZombieDetector();

  // ---- L5: 内存泄漏监控 ----
  installMemoryMonitor();

  // ---- 启动成功：清除 reload 计数 ----
  // 如果走到这里说明页面正常加载了，清除之前的 reload 保护计数
  // 延迟 3 秒确认 app 确实稳定运行了
  setTimeout(() => {
    try {
      clearRecoveryCounters();
    } catch { /* ignore */ }
  }, 3000);

  console.log('[SilentRecovery] Installed (L2 + L4)');
}
