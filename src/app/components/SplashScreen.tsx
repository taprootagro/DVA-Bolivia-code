import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";
import { useLanguage } from "../hooks/useLanguage";
import type { SplashScreenConfig } from "../hooks/useHomeConfig";
import { CmsMediaImg } from "./CmsMediaImg";
import { isNative, splashScreen } from "../utils/capacitor-bridge";

/**
 * SplashScreen — 可配置启动页：全屏背景图（白底占位 + 淡入）、最短展示、资源预加载超时、跳过
 * 退场动画结束后 navigate('/home')；PWA 冷启动与 Layout 的 SPLASH_SHOWN_KEY 逻辑不变。
 */
export const SPLASH_SHOWN_KEY = '__taproot_splash_shown__';

const SPLASH_DEFAULTS: SplashScreenConfig = {
  imageUrl: "",
  minDisplayMs: 2000,
  maxResourceWaitMs: 4000,
  showSkipButton: true,
};

/** 有启动图时的占位背景（白底，与 index.html / 无图 splash 一致，过渡最不显眼） */
const SPLASH_PLACEHOLDER_BG = "#ffffff";
const SPLASH_IMAGE_FADE_MS = 500;

export function SplashScreen() {
  const navigate = useNavigate();
  const { config } = useConfigContext();
  const { resolve: resolveMedia } = useCmsMediaUrl();
  const { t } = useLanguage();
  const splash = useMemo((): SplashScreenConfig => {
    const s = config?.splashScreen;
    const nativeMin = isNative() ? 800 : SPLASH_DEFAULTS.minDisplayMs;
    if (!s) return { ...SPLASH_DEFAULTS, minDisplayMs: nativeMin };
    return {
      imageUrl: typeof s.imageUrl === "string" ? s.imageUrl : "",
      minDisplayMs: Number.isFinite(s.minDisplayMs)
        ? Math.max(0, isNative() ? Math.min(s.minDisplayMs, 800) : s.minDisplayMs)
        : (isNative() ? 800 : SPLASH_DEFAULTS.minDisplayMs),
      maxResourceWaitMs: Number.isFinite(s.maxResourceWaitMs)
        ? Math.max(300, s.maxResourceWaitMs)
        : SPLASH_DEFAULTS.maxResourceWaitMs,
      showSkipButton: s.showSkipButton !== false,
    };
  }, [config?.splashScreen]);

  const bgUrl = useMemo(
    () => resolveMedia(splash.imageUrl.trim()),
    [splash.imageUrl, resolveMedia],
  );
  const onImage = splash.imageUrl.trim().length > 0;

  const [minTimePassed, setMinTimePassed] = useState(false);
  const [resourceReady, setResourceReady] = useState(false);
  const [splashImageReady, setSplashImageReady] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const splashExitDoneRef = useRef(false);

  const commitSplashExit = useCallback(() => {
    if (splashExitDoneRef.current) return;
    splashExitDoneRef.current = true;
    if (isNative()) {
      void splashScreen.hide();
    }
    try {
      sessionStorage.setItem(SPLASH_SHOWN_KEY, "1");
    } catch {
      /* ignore */
    }
    navigate("/home", { replace: true });
  }, [navigate]);

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute("content") || "#059669";
    meta?.setAttribute("content", SPLASH_PLACEHOLDER_BG);
    return () => {
      meta?.setAttribute("content", prev);
    };
  }, []);

  useEffect(() => {
    const pendingUpdate = sessionStorage.getItem('taproot_sw_pending_update');
    if (pendingUpdate === '1' && navigator.serviceWorker?.controller) {
      sessionStorage.removeItem('taproot_sw_pending_update');
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setMinTimePassed(true), splash.minDisplayMs);
    return () => clearTimeout(timer);
  }, [splash.minDisplayMs]);

  // 启动图加载完成后再淡入（占位为白底，避免黑屏）
  useEffect(() => {
    if (!onImage) {
      setSplashImageReady(false);
      return;
    }
    setSplashImageReady(false);
    let cancelled = false;
    const img = new Image();
    const markReady = () => {
      if (!cancelled) setSplashImageReady(true);
    };
    img.onload = markReady;
    img.onerror = () => {
      /* 加载失败则保持白底占位，不淡入破损图 */
    };
    img.src = bgUrl;
    if (img.complete && img.naturalWidth > 0) markReady();
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [bgUrl, onImage]);

  // 并行预加载：启动图 + 首张 banner；整体不超过 maxResourceWaitMs
  useEffect(() => {
    const firstBanner = config?.banners?.[0]?.url?.trim();
    const urls = [bgUrl || null, firstBanner || null].filter(Boolean) as string[];

    if (urls.length === 0) {
      setResourceReady(true);
      return;
    }

    let cancelled = false;
    const loadOne = (url: string) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = url;
      });

    const all = Promise.all(urls.map(loadOne));
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, splash.maxResourceWaitMs);
    });

    void Promise.race([all, timeout]).then(() => {
      if (!cancelled) setResourceReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [config?.banners, bgUrl, splash.maxResourceWaitMs]);

  useEffect(() => {
    if (exiting) return;
    if (skipped || (minTimePassed && resourceReady)) {
      void import("./HomePage");
      setExiting(true);
    }
  }, [minTimePassed, resourceReady, exiting, skipped]);

  // 部分 WebView / PWA 环境不触发 animationend，仅靠动画结束会永远卡在开屏
  useEffect(() => {
    if (!exiting) return;
    const t = window.setTimeout(() => commitSplashExit(), 480);
    return () => clearTimeout(t);
  }, [exiting, commitSplashExit]);

  const handleAnimationEnd = useCallback(
    (e: React.AnimationEvent<HTMLDivElement>) => {
      if (!exiting) return;
      if (e.target !== e.currentTarget) return;
      commitSplashExit();
    },
    [exiting, commitSplashExit],
  );

  const textOnDark = onImage && splashImageReady;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden px-[5vw]"
      style={{
        height: 'var(--app-height, 100dvh)',
        animation: exiting ? 'splash-exit 200ms ease-in forwards' : undefined,
        willChange: exiting ? 'transform, opacity' : 'auto',
        backgroundColor: SPLASH_PLACEHOLDER_BG,
      }}
      onAnimationEnd={handleAnimationEnd}
    >
      {onImage && (
        <CmsMediaImg
          src={splash.imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover pointer-events-none"
          decoding="async"
          style={{
            opacity: splashImageReady ? 1 : 0,
            transition: `opacity ${SPLASH_IMAGE_FADE_MS}ms ease-out`,
          }}
          onLoad={() => setSplashImageReady(true)}
        />
      )}

      <div className={`${onImage ? 'bg-black/0' : 'bg-white'} safe-top fixed top-0 inset-x-0 z-30 pointer-events-none h-0`} />

      {splash.showSkipButton && !exiting && (
        <button
          type="button"
          onClick={() => setSkipped(true)}
          className={`absolute z-20 px-3 py-1.5 rounded-full text-sm font-medium active:scale-95 transition-transform ${
            textOnDark
              ? 'bg-white/90 text-gray-800'
              : 'bg-gray-800/10 text-gray-700'
          }`}
          style={{
            top: 'max(12px, env(safe-area-inset-top, 0px))',
            right: 'max(12px, env(safe-area-inset-right, 0px))',
          }}
        >
          {t.common.skip}
        </button>
      )}

      <div className="relative z-10 flex flex-col items-center justify-center flex-1 w-full min-h-0">
        {/* 有自定义启动图时，只显示加载动画；无图时显示品牌 logo + 名称 + slogan */}
        {onImage ? (
          <div className="absolute bottom-[15vh] left-0 right-0 flex justify-center">
            <div className="flex gap-[1vw]">
              {[0, 150, 300].map((delay) => (
                <div
                  key={delay}
                  className="rounded-full animate-bounce bg-emerald-600"
                  style={{
                    width: 'clamp(8px, 2.5vw, 12px)',
                    height: 'clamp(8px, 2.5vw, 12px)',
                    animationDelay: `${delay}ms`,
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            <div
              className="rounded-3xl flex items-center justify-center mb-[4vh] shadow-xl overflow-hidden bg-white"
              style={{
                width: 'clamp(140px, 32vw, 180px)',
                height: 'clamp(140px, 32vw, 180px)',
                borderRadius: 'clamp(24px, 7vw, 36px)',
              }}
            >
              {config?.appBranding?.logoUrl ? (
                <CmsMediaImg
                  src={config.appBranding.logoUrl}
                  alt="Logo"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span
                  className="text-emerald-600 font-bold"
                  style={{ fontSize: 'clamp(60px, 16vw, 90px)' }}
                >
                  🌱
                </span>
              )}
            </div>

            <h1
              className="font-bold text-center mb-[1vh] text-gray-900"
              style={{ fontSize: 'clamp(20px, 6vw, 32px)' }}
            >
              {config?.appBranding?.appName || "TaprootAgro"}
            </h1>
            <p
              className="text-center leading-relaxed max-w-[90vw] whitespace-nowrap text-gray-500"
              style={{ fontSize: 'clamp(10px, 2.8vw, 14px)' }}
            >
              {config?.appBranding?.slogan || "To be the taproot of smart agro."}
            </p>

            <div className="absolute bottom-[15vh] left-0 right-0 flex justify-center">
              <div className="flex gap-[1vw]">
                {[0, 150, 300].map((delay) => (
                  <div
                    key={delay}
                    className="rounded-full animate-bounce bg-emerald-600"
                    style={{
                      width: 'clamp(8px, 2.5vw, 12px)',
                      height: 'clamp(8px, 2.5vw, 12px)',
                      animationDelay: `${delay}ms`,
                    }}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
