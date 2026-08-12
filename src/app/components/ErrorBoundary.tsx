import { Component, type ReactNode, type ErrorInfo } from 'react';
import { errorMonitor } from '../utils/errorMonitor';
import {
  executeVersionRecovery,
  clearRecoveryCounters,
  EB_RELOAD_COUNT_KEY,
  isChunkLoadError,
} from '../utils/versionRecovery';
import { RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional fallback UI. If not provided, default recovery UI is shown */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  /** 静默重试计数 — 用户不可见 */
  silentRetryCount: number;
}

/** 静默重试上限：超过此次数才考虑 reload 或展示错误 UI */
const MAX_SILENT_RETRIES = 3;

/** sessionStorage key — 防止 reload 无限循环（legacy; cleared by versionRecovery） */
const RELOAD_COUNT_KEY = EB_RELOAD_COUNT_KEY;
const MAX_RELOAD_COUNT = 3;

/**
 * 检测是否为 chunk 加载失败错误（版本更新导致旧 chunk 不存在）
 */
function isChunkLoadErrorLocal(error: Error | null): boolean {
  return isChunkLoadError(error);
}

/**
 * 判断错误是否为"确定性错误"——即重试不可能修复的错误。
 * 这类错误应跳过静默重试，直接展示恢复 UI，避免浪费用户时间和流量。
 */
function isDeterministicError(error: Error | null): boolean {
  if (!error) return false;
  const name = error.name || '';
  const msg = error.message || '';

  // SyntaxError / ReferenceError 是代码级 bug，重试无意义
  if (name === 'SyntaxError' || name === 'ReferenceError') return true;

  // TypeError 中部分模式是确定性的（属性访问 null/undefined）
  if (name === 'TypeError') {
    if (
      msg.includes('Cannot read propert') || // "Cannot read properties of undefined/null"
      msg.includes('is not a function') ||
      msg.includes('is not iterable') ||
      msg.includes('Cannot destructure') ||
      msg.includes('is not a constructor')
    ) {
      return true;
    }
  }

  // 明确的 hook 规则违反
  if (msg.includes('Rendered more hooks than') || msg.includes('Rendered fewer hooks')) {
    return true;
  }

  return false;
}

/** Session / chat init races during role shell swap — retry instead of reload loop */
function isRecoverableInitError(error: Error | null): boolean {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('session uid mismatch') ||
    msg.includes('no valid oauth/session token') ||
    msg.includes('sign in again') ||
    msg.includes('not ready') ||
    msg.includes('getsession failed')
  );
}

/** 返回错误分类标签，用于上报和日志 */
function classifyError(error: Error | null): 'chunk' | 'deterministic' | 'transient' | 'recoverable-init' {
  if (isChunkLoadErrorLocal(error)) return 'chunk';
  if (isDeterministicError(error)) return 'deterministic';
  if (isRecoverableInitError(error)) return 'recoverable-init';
  return 'transient';
}

/**
 * 尝试自动恢复 chunk 加载失败：soft recovery（清 shell 缓存 + reload）
 */
function attemptChunkRecovery(): void {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  void executeVersionRecovery();
}

/**
 * 静默 reload — 带防循环保护
 * @returns true 表示正在执行 reload；false 表示已达上限，不再 reload
 */
function silentReload(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_COUNT_KEY);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= MAX_RELOAD_COUNT) {
      // 已经 reload 过多次，放弃 — 让错误 UI 显示
      sessionStorage.removeItem(RELOAD_COUNT_KEY);
      return false;
    }
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1));
    // 稍等片刻让日志写入完成
    setTimeout(() => window.location.reload(), 300);
    return true;
  } catch {
    return false;
  }
}

/**
 * ErrorBoundary v2 — 静默自愈优先
 *
 * 策略：
 *   1. 首次崩溃 → 静默重试（用户无感），最多 MAX_SILENT_RETRIES 次
 *   2. 静默重试耗尽 → 尝试静默 reload（用户看到的是"重新加载"，不是报错）
 *   3. reload 也失败（循环保护触发）→ 最终展示简洁的恢复 UI
 *
 * Chunk 加载失败单独处理：直接走 chunk recovery 流程（清缓存+刷新）
 */
export class ErrorBoundary extends Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      silentRetryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });

    // ---- Chunk 加载失败：走专属恢复流程 ----
    if (isChunkLoadErrorLocal(error)) {
      errorMonitor.capture(error, { type: 'react', context: 'ChunkLoadError' });
      // 离线：不清缓存、不刷新，避免与用户「无操作」预期冲突
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }
      console.warn('[ErrorBoundary] Chunk load error, attempting recovery...');
      attemptChunkRecovery();
      return;
    }

    // ---- 错误分类 ----
    const errorCategory = classifyError(error);

    // ---- 上报错误（静默，不影响流程）----
    errorMonitor.capture(error, {
      type: 'react',
      componentStack: errorInfo.componentStack || undefined,
      context: `ErrorBoundary-${errorCategory}-retry-${this.state.silentRetryCount}`,
    });

    // ---- 确定性错误：跳过静默重试，直接进入恢复流程 ----
    if (errorCategory === 'deterministic') {
      console.warn(
        `[ErrorBoundary] Deterministic error detected (${error.name}: ${error.message}), skipping silent retries`
      );
      // 尝试静默 reload（可能是缓存了旧代码）
      if (silentReload()) {
        return;
      }
      // reload 也耗尽 → 展示错误 UI
      console.error('[ErrorBoundary] All recovery attempts failed, showing error UI');
      return;
    }

    // ---- 角色切换 / 会话未就绪：多几次静默重试，避免 recovery 环 ----
    if (errorCategory === 'recoverable-init') {
      const initRetryCap = MAX_SILENT_RETRIES + 2;
      const currentRetry = this.state.silentRetryCount;
      if (currentRetry < initRetryCap) {
        console.warn(
          `[ErrorBoundary] Recoverable init error, silent retry ${currentRetry + 1}/${initRetryCap}...`,
        );
        const delay = 150 * Math.pow(2, currentRetry);
        this.retryTimer = setTimeout(() => {
          this.setState(prev => ({
            hasError: false,
            error: null,
            errorInfo: null,
            silentRetryCount: prev.silentRetryCount + 1,
          }));
        }, delay);
        return;
      }
    }

    // ---- L1 静默重试：用户完全无感（仅暂态错误）----
    const currentRetry = this.state.silentRetryCount;
    if (currentRetry < MAX_SILENT_RETRIES) {
      console.warn(
        `[ErrorBoundary] Silent retry ${currentRetry + 1}/${MAX_SILENT_RETRIES}...`
      );
      // 短延迟后重置 error state，触发重新渲染
      // 延迟递增：100ms → 200ms → 400ms，给异步资源加载留时间
      const delay = 100 * Math.pow(2, currentRetry);
      this.retryTimer = setTimeout(() => {
        this.setState(prev => ({
          hasError: false,
          error: null,
          errorInfo: null,
          silentRetryCount: prev.silentRetryCount + 1,
        }));
      }, delay);
      return;
    }

    // ---- 静默重试耗尽 → 尝试静默 reload ----
    console.warn('[ErrorBoundary] Silent retries exhausted, attempting silent reload...');
    if (silentReload()) {
      return; // 正在 reload，不展示 UI
    }

    // ---- 所有自动恢复手段耗尽 → 展示错误 UI（最后手段）----
    console.error('[ErrorBoundary] All recovery attempts failed, showing error UI');
  }

  componentWillUnmount() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
  }

  handleRetry = () => {
    clearRecoveryCounters();
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      silentRetryCount: 0,
    });
  };

  handleReset = () => {
    window.location.href = '/sw-reset';
  };

  handleReload = () => {
    void executeVersionRecovery();
  };

  /** Lightweight i18n (class component can't use hooks) */
  private getLabels() {
    const rawLang = typeof navigator !== 'undefined' ? navigator.language : 'en';
    const lang = rawLang.toLowerCase();
    
    // Support 20 languages
    if (lang.startsWith('zh-tw') || lang.startsWith('zh-hk')) return { title: '應用遇到問題', refresh: '刷新頁面', reset: '重置應用（清緩存）', desc: '可先刷新頁面；仍無法使用時再重置應用' };
    if (lang.startsWith('zh')) return { title: '应用遇到问题', refresh: '刷新页面', reset: '重置应用（清缓存）', desc: '可先刷新页面；仍无法使用时再重置应用' };
    if (lang.startsWith('fr')) return { title: "L'application a rencontré un problème", restart: "Redémarrer l'application", desc: "Il est recommandé de redémarrer l'application" };
    if (lang.startsWith('es')) return { title: 'La aplicación encontró un problema', restart: 'Reiniciar aplicación', desc: 'Se recomienda reiniciar la aplicación para uso normal' };
    if (lang.startsWith('ar')) return { title: 'واجه التطبيق مشكلة', restart: 'إعادة تشغيل التطبيق', desc: 'يُنصح بإعادة تشغيل التطبيق لاستئناف الاستخدام الطبيعي' };
    if (lang.startsWith('sw')) return { title: 'Programu imekutana na tatizo', restart: 'Anzisha upya programu', desc: 'Inashauriwa kuanzisha upya programu' };
    if (lang.startsWith('pt')) return { title: 'O aplicativo encontrou um problema', restart: 'Reiniciar aplicativo', desc: 'Recomenda-se reiniciar o aplicativo para uso normal' };
    if (lang.startsWith('ru')) return { title: 'В приложении произошла ошибка', restart: 'Перезапустить', desc: 'Рекомендуется перезапустить приложение' };
    if (lang.startsWith('tr')) return { title: 'Uygulama bir sorunla karşılaştı', restart: 'Yeniden Başlat', desc: 'Normal kullanıma dönmek için uygulamayı yeniden başlatın' };
    if (lang.startsWith('th')) return { title: 'แอปพลิเคชันพบปัญหา', restart: 'รีสตาร์ทแอป', desc: 'โปรดรีสตาร์ทแอปพลิเคชันเพื่อใช้งานต่อ' };
    if (lang.startsWith('ja')) return { title: 'アプリに問題が発生しました', restart: '再起動', desc: '正常に使用するために再起動をお勧めします' };
    if (lang.startsWith('id')) return { title: 'Aplikasi mengalami masalah', restart: 'Mulai Ulang Aplikasi', desc: 'Disarankan untuk memulai ulang aplikasi' };
    if (lang.startsWith('bn')) return { title: 'অ্যাপে একটি সমস্যা হয়েছে', restart: 'অ্যাপ পুনরায় চালু করুন', desc: 'স্বাভাবিক ব্যবহারের জন্য অ্যাপটি পুনরায় চালু করুন' };
    if (lang.startsWith('vi')) return { title: 'Ứng dụng gặp sự cố', restart: 'Khởi động lại', desc: 'Vui lòng khởi động lại ứng dụng' };
    if (lang.startsWith('fa')) return { title: 'برنامه با مشکلی روبرو شد', restart: 'راه‌اندازی مجدد', desc: 'برای استفاده عادی، برنامه را مجدداً راه‌اندازی کنید' };
    if (lang.startsWith('my')) return { title: 'အက်ပ်တွင်ပြဿနာရှိနေပါသည်', restart: 'အက်ပ်ကိုပြန်စရန်', desc: 'ပုံမှန်အသုံးပြုရန် အက်ပ်ကိုပြန်စပါ' };
    if (lang.startsWith('ms')) return { title: 'Aplikasi menghadapi masalah', restart: 'Mula Semula', desc: 'Sila mula semula aplikasi untuk penggunaan biasa' };
    if (lang.startsWith('tl')) return { title: 'Nagkaproblema ang app', restart: 'I-restart ang App', desc: 'Paki-restart ang app upang magpatuloy' };
    if (lang.startsWith('ur')) return { title: 'ایپ میں مسئلہ پیش آیا ہے', restart: 'ایپ دوبارہ شروع کریں', desc: 'براہ کرم ایپ کو دوبارہ شروع کریں' };
    if (lang.startsWith('hi')) return { title: 'ऐप में कोई समस्या आई है', restart: 'ऐप रीस्टार्ट करें', desc: 'सामान्य उपयोग फिर से शुरू करने के लिए कृपया ऐप रीस्टार्ट करें' };

    return { title: 'App encountered a problem', refresh: 'Refresh page', reset: 'Reset app (clear cache)', desc: 'Try refreshing first. Reset only if the problem persists.' };
  }

  render() {
    if (this.state.hasError) {
      // 如果还在静默重试阶段（暂态错误），渲染空白而非错误 UI
      // 确定性错误不走静默重试，直接跳到错误 UI
      const errorCategory = classifyError(this.state.error);
      const maxSilentRetries =
        errorCategory === 'recoverable-init'
          ? MAX_SILENT_RETRIES + 2
          : MAX_SILENT_RETRIES;
      if (
        (errorCategory === 'transient' || errorCategory === 'recoverable-init') &&
        this.state.silentRetryCount < maxSilentRetries
      ) {
        return (
          <div
            style={{
              height: '100vh',
              background: '#f0fdf4',
            }}
          />
        );
      }

      // 自定义 fallback
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // ---- 最终兜底 UI：刷新优先，重置为次要 ----
      const labels = this.getLabels();
      const refreshLabel =
        'refresh' in labels ? labels.refresh : (labels as { restart?: string }).restart ?? 'Refresh page';
      const resetLabel =
        'reset' in labels ? labels.reset : 'Reset app (clear cache)';

      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            background: '#f0fdf4',
            color: '#065f46',
            textAlign: 'center',
            padding: '2rem',
          }}
        >
          <div style={{ maxWidth: '320px', width: '100%' }}>
            {/* 友好图标 */}
            <div
              style={{
                width: 64,
                height: 64,
                margin: '0 auto 1.25rem',
                borderRadius: '50%',
                background: '#dcfce7',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <RefreshCw size={28} color="#10b981" />
            </div>

            <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.125rem' }}>
              {labels.title}
            </h2>
            <p style={{ color: '#6b7280', margin: '0 0 1.5rem', fontSize: '0.8125rem' }}>
              {labels.desc}
            </p>

            <button
              onClick={this.handleReload}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1.5rem',
                background: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '0.75rem',
                fontSize: '0.9375rem',
                cursor: 'pointer',
                width: '100%',
                marginBottom: '0.75rem',
              }}
            >
              <RefreshCw size={16} />
              {refreshLabel}
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                padding: '0.5rem 1rem',
                background: 'transparent',
                color: '#6b7280',
                border: 'none',
                borderRadius: '0.5rem',
                fontSize: '0.8125rem',
                cursor: 'pointer',
                width: '100%',
                textDecoration: 'underline',
              }}
            >
              {resetLabel}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}