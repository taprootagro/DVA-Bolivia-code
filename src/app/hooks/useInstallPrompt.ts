import { useState, useEffect, useCallback, useRef } from 'react';
import { isNative } from '../utils/capacitor-bridge';

/**
 * PWA Install Prompt Hook
 *
 * 事件捕获策略（双保险）：
 * 1. index.html inline script — HTML 解析阶段同步注册 beforeinstallprompt 监听，
 *    事件存入 window.__pwaInstallPrompt。这是最早时机，解决 Edge Android 等浏览器
 *    在 JS bundle 加载前就触发事件导致丢失的问题。
 * 2. 本模块的模块级监听器 — 作为后备，覆盖事件在 bundle 加载后才触发的浏览器。
 * 3. serviceWorker.ready + 短时轮询 — Edge/Chrome 常在 SW 控制页面后才派发 beforeinstallprompt；
 *    从 window.__pwaInstallPrompt 同步，避免首访横幅已出但 prompt 尚未就绪。
 *
 * Capacitor 原生壳：不展示安装条（与 PWAInstallBanner 一致）。
 *
 * 浏览器内：仅在「已安装的浏览器 PWA」（standalone 等）下隐藏；否则可在每次回到标签页 /
 * pageshow 时再次尝试展示。用户点关闭不写 session，下次可见性恢复仍会再试。
 */

// ── 类型 ──────────────────────────────────────────────────────────
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'android' | 'ios' | null;

export type UseInstallPromptOptions = {
  /** 为 true 时隐藏安装条，但保留已捕获的 beforeinstallprompt */
  suppressed?: boolean;
};

export type UseInstallPromptResult = {
  showBanner: boolean;
  platform: InstallPlatform;
  triggerInstall: () => Promise<void>;
  dismiss: () => void;
  /** 当前环境是否可能出现「添加到主屏幕」提示 */
  installEligible: boolean;
  /** 用户是否手动关闭了安装条（本次会话） */
  userDismissed: boolean;
  /** 安装条当前是否已就绪（不受 suppressed 影响） */
  bannerReady: boolean;
  /** 安装条是否曾就绪并展示过 */
  bannerEverReady: boolean;
  /** 用户是否已尝试安装（无论成功/取消） */
  installAttemptFinished: boolean;
};

// ── 全局共享状态 ──────────────────────────────────────────────────
// index.html inline script 已经把事件存在 window.__pwaInstallPrompt 上，
// 这里的模块级监听器作为后备（覆盖 bundle 加载后才触发的情况）。
const _promptListeners = new Set<(e: BeforeInstallPromptEvent) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    // 更新 window 全局引用（index.html 的监听器可能已经存了，这里覆盖也无害）
    (window as any).__pwaInstallPrompt = e as BeforeInstallPromptEvent;
    // 通知所有已挂载的 hook 实例
    _promptListeners.forEach(fn => fn(e as BeforeInstallPromptEvent));
  });
}

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 读取 index.html 捕获的事件 */
function getCapturedPrompt(): BeforeInstallPromptEvent | null {
  return (window as any).__pwaInstallPrompt ?? null;
}

/** 清除全局事件引用（安装成功或用完后） */
function clearCapturedPrompt(): void {
  (window as any).__pwaInstallPrompt = null;
}

/**
 * 是否应隐藏「添加到主屏幕」提示：Capacitor 壳、或浏览器内已安装的 PWA。
 */
export function shouldHideInstallBanner(): boolean {
  try {
    if (isNative()) return true;
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
    if ((navigator as any).standalone === true) return true;
    if (document.referrer.includes('android-app://')) return true;
  } catch { /* ignore */ }
  return false;
}

/** 检测 iOS */
function detectIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}

// ── Hook ──────────────────────────────────────────────────────────

export function useInstallPrompt(options: UseInstallPromptOptions = {}): UseInstallPromptResult {
  const { suppressed = false } = options;
  const [showBanner, setShowBanner] = useState(false);
  const [platform, setPlatform] = useState<InstallPlatform>(null);
  /** Chromium only: true 表示当前持有可用的 beforeinstallprompt（安装条可安全展示） */
  const [chromiumPromptHeld, setChromiumPromptHeld] = useState(false);
  const [userDismissed, setUserDismissed] = useState(false);
  const [installAttemptFinished, setInstallAttemptFinished] = useState(false);
  const [bannerEverReady, setBannerEverReady] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const installEligible = typeof window !== 'undefined' && !shouldHideInstallBanner();

  const bannerReady =
    showBanner &&
    !!platform &&
    (platform === 'ios' || chromiumPromptHeld);

  useEffect(() => {
    if (bannerReady) setBannerEverReady(true);
  }, [bannerReady]);

  useEffect(() => {
    if (shouldHideInstallBanner()) return;

    const installedHandler = () => {
      setShowBanner(false);
      setChromiumPromptHeld(false);
      deferredPrompt.current = null;
      clearCapturedPrompt();
    };

    // ── iOS Safari / 浏览器 ──
    if (detectIOS()) {
      const timer = setTimeout(() => {
        if (!shouldHideInstallBanner()) {
          setPlatform('ios');
          setShowBanner(true);
        }
      }, 1500);
      window.addEventListener('appinstalled', installedHandler);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('appinstalled', installedHandler);
      };
    }

    // ── Android / Chrome / Edge (Chromium PWA) ──
    const tryApplyCapture = (): boolean => {
      if (shouldHideInstallBanner()) return false;
      const c = getCapturedPrompt();
      if (!c) return false;
      deferredPrompt.current = c;
      setChromiumPromptHeld(true);
      setPlatform('android');
      setShowBanner(true);
      return true;
    };

    window.addEventListener('appinstalled', installedHandler);

    if (tryApplyCapture()) {
      return () => window.removeEventListener('appinstalled', installedHandler);
    }

    const handler = (e: BeforeInstallPromptEvent) => {
      deferredPrompt.current = e;
      if (!shouldHideInstallBanner()) {
        setChromiumPromptHeld(true);
        setPlatform('android');
        setShowBanner(true);
      }
    };
    _promptListeners.add(handler);

    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(() => {
        if (cancelled || shouldHideInstallBanner()) return;
        tryApplyCapture();
      });
    }

    let n = 0;
    pollId = setInterval(() => {
      if (cancelled || shouldHideInstallBanner()) {
        if (pollId) clearInterval(pollId);
        pollId = null;
        return;
      }
      if (tryApplyCapture() || ++n > 25) {
        if (pollId) clearInterval(pollId);
        pollId = null;
      }
    }, 200);

    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
      _promptListeners.delete(handler);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, []);

  // 浏览器：每次回到页签 / bfcache 恢复 → 再次尝试展示（壳内已由 shouldHideInstallBanner 排除）
  useEffect(() => {
    const refresh = () => {
      if (shouldHideInstallBanner()) {
        setShowBanner(false);
        return;
      }
      if (detectIOS()) {
        setPlatform('ios');
        setShowBanner(true);
        return;
      }
      const c = getCapturedPrompt();
      if (c) {
        deferredPrompt.current = c;
        setChromiumPromptHeld(true);
        setPlatform('android');
        setShowBanner(true);
      }
    };

    const schedule = () => window.setTimeout(refresh, 280);

    const onPageShow = () => schedule();
    window.addEventListener('pageshow', onPageShow);

    let wasHidden = false;
    const onVis = () => {
      if (document.hidden) {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const triggerInstall = useCallback(async () => {
    const prompt = deferredPrompt.current || getCapturedPrompt();
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // prompt() 单次有效或异常：收起条子，避免死按钮
    } finally {
      deferredPrompt.current = null;
      clearCapturedPrompt();
      setChromiumPromptHeld(false);
      setShowBanner(false);
      setInstallAttemptFinished(true);
    }
  }, []);

  const dismiss = useCallback(() => {
    setUserDismissed(true);
    setShowBanner(false);
    setChromiumPromptHeld(false);
    deferredPrompt.current = null;
    // 不写 clearCapturedPrompt：与原先一致，避免误丢尚未 prompt 的全局事件
  }, []);

  /** iOS：可展示；Chromium：须已捕获 beforeinstallprompt */
  const showInstallBanner = !suppressed && bannerReady;

  return {
    showBanner: showInstallBanner,
    platform,
    triggerInstall,
    dismiss,
    installEligible,
    userDismissed,
    bannerReady,
    bannerEverReady,
    installAttemptFinished,
  };
}
