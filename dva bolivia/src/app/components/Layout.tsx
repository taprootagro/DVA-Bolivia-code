import { Link, useLocation, Navigate, type Location } from "react-router";
import { useKeyboardVisible } from "../hooks/useKeyboardVisible";
import { Home, NotebookText, MessageCircle, User } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { useState, useEffect, lazy, Suspense, useRef, useCallback, type ReactNode } from "react";
import { PWAInstallBanner } from "./PWAInstallBanner";
import { PermissionsIntroSheet } from "./PermissionsIntroSheet";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import { useChatUnreadCount } from "../utils/storeChatUnread";
import { setActiveTab } from "../utils/chatTabActive";
import {
  evaluateFirstLaunchPermissionFlow,
  markFirstLaunchPermissionIntroDone,
  requestAllPendingPermissions,
} from "../utils/appPermissions";
import { SPLASH_SHOWN_KEY } from "./SplashScreen";
import { useBackHandler } from "../hooks/useBackHandler";
import { isNative, bridge } from "../utils/capacitor-bridge";
import {
  HomePageSkeleton,
  MarketPageSkeleton,
  CommunityPageSkeleton,
  ProfilePageSkeleton,
  SkeletonScreen,
} from "./SkeletonScreen";

/** 设置挂在 /home/settings 时用：底部 Dock 仍应对应「返回后」的那一 tab（避免误判成首页）。 */
function getDockBasePath(location: Location): string {
  if (location.pathname === "/home/settings") {
    const st = location.state as { settingsFrom?: string } | null;
    const from = typeof st?.settingsFrom === "string" ? st.settingsFrom.trim() : "";
    if (from.startsWith("/home")) return from;
    const tab = new URLSearchParams(location.search).get("tab");
    const map = {
      home: "/home",
      market: "/home/market",
      community: "/home/community",
      profile: "/home/profile",
    } as const;
    if (tab && tab in map) return map[tab as keyof typeof map];
    return "/home/profile";
  }
  return location.pathname;
}

// Keep-alive: 懒加载但只挂载一次，切换时不卸载
const HomePage = lazy(() => import("./HomePage"));
const MarketPage = lazy(() => import("./MarketPage"));
const CommunityPage = lazy(() => import("./CommunityPage"));
const ProfilePage = lazy(() => import("./ProfilePage"));
const SettingsPageLazy = lazy(() => import("./SettingsPage"));

// 预加载映射 - 根据路径预加载对应组件
const preloadMap: Record<string, () => Promise<any>> = {
  "/home": () => import("./HomePage"),
  "/home/market": () => import("./MarketPage"),
  "/home/community": () => import("./CommunityPage"),
  "/home/profile": () => import("./ProfilePage"),
};

// Tab key 到 index 的映射
const TAB_KEYS = ["home", "market", "community", "profile"] as const;

/** Tab 懒加载 chunk 未到时显示对应骨架 */
const TAB_SUSPENSE_FALLBACK: Record<(typeof TAB_KEYS)[number], ReactNode> = {
  home: <HomePageSkeleton />,
  market: <MarketPageSkeleton />,
  community: <CommunityPageSkeleton />,
  profile: <ProfilePageSkeleton />,
};

export function Layout() {
  const location = useLocation();
  const dockBasePath = getDockBasePath(location);
  const settingsOpen = location.pathname === "/home/settings";

  // ---- 所有 hooks 必须无条件调用（React Rules of Hooks）----
  const { t, isRTL } = useLanguage();
  const keyboardVisible = useKeyboardVisible();
  const chatUnread = useChatUnreadCount();

  // ---- 禁止左右滑动切换页面（浏览器前进/后退手势）----
  // 在 PWA 桌面模式下，国产浏览器（小米/OPPO/vivo）和 Chrome 的边缘左右滑动
  // 会触发浏览器的 history.back()/forward()，导致页面意外切换。
  // 通过拦截屏幕边缘的横向滑动手势来阻止此行为。
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  
  useEffect(() => {
    const handleTouchStartCapture = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) {
        touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      }
    };

    const handleTouchMoveCapture = (e: TouchEvent) => {
      if (!touchStartRef.current || !e.touches[0]) return;
      const touch = e.touches[0];
      const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
      const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);
      
      // 如果是明显的横向滑动（横向位移 > 纵向位移 × 1.5），
      // 且起始点在屏幕边缘 40px 内（浏览器手势触发区），则阻止
      const startX = touchStartRef.current.x;
      const screenW = window.innerWidth;
      const isEdgeSwipe = startX < 40 || startX > screenW - 40;
      
      if (isEdgeSwipe && deltaX > 10 && deltaX > deltaY * 1.5) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleTouchEnd = () => {
      touchStartRef.current = null;
    };

    // 使用 capture 阶段拦截，确保在冒泡前就阻止
    document.addEventListener('touchstart', handleTouchStartCapture, { passive: true, capture: true });
    document.addEventListener('touchmove', handleTouchMoveCapture, { passive: false, capture: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: true, capture: true });

    // ---- 禁止长按弹出上下文菜单（"在新标签页打开"等）----
    // Android Chrome / 国产浏览器长按链接或按钮会触发 contextmenu 事件，
    // 弹出"在新标签页中打开"、"复制链接"等系统菜单，严重影响 PWA 体验。
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };
    document.addEventListener('contextmenu', handleContextMenu, { capture: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStartCapture, true);
      document.removeEventListener('touchmove', handleTouchMoveCapture, true);
      document.removeEventListener('touchend', handleTouchEnd, true);
      document.removeEventListener('touchcancel', handleTouchEnd, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
    };
  }, []);

  // 记录已访问过的 tab，实现「首次访问才懒加载，之后常驻」
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() =>
    new Set([getTabKey(getDockBasePath(location))]),
  );

  const activeTab = getTabKey(dockBasePath);

  useEffect(() => {
    setActiveTab(activeTab);
  }, [activeTab]);

  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;

  // ── Dock 层级系统返回手势 / 返回键处理 ──
  // 非首页 tab → 回到首页；首页 → 退出 app（Capacitor 原生）
  // pushHistory=false：不推入浏览器历史条目，让 React Router 自然管理 tab 路由
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const dockBackHandler = useCallback(() => {
    if (settingsOpenRef.current) {
      history.back();
      return;
    }
    if (activeTabRef.current !== 'home') {
      // 非首页 tab → 导航回首页
      // 直接修改 location 让 React Router 处理，避免推入额外 history 条目
      window.location.hash = ''; // 清除可能的 hash
      history.replaceState(null, '', '/home');
      // 触发 React Router 感知 URL 变化
      window.dispatchEvent(new PopStateEvent('popstate'));
    } else {
      // 首页 → 退出 app
      if (isNative()) {
        void bridge.app.exitApp();
      }
    }
  }, []);

  useBackHandler(dockBackHandler, false);

  // Tab 换淡入动画：追踪切换计数，用 CSS animation 触发
  const switchCountRef = useRef(0);
  const prevTabRef = useRef(activeTab);
  const [fadeKey, setFadeKey] = useState(0);
  const [permissionsIntroOpen, setPermissionsIntroOpen] = useState(false);
  const [permissionsIntroPending, setPermissionsIntroPending] = useState(false);
  const [permissionsRequesting, setPermissionsRequesting] = useState(false);
  const [installWaitExpired, setInstallWaitExpired] = useState(false);
  const permissionsFlowStartedRef = useRef(false);

  const installPrompt = useInstallPrompt({
    // 仅在权限说明弹层打开时隐藏安装条；系统授权框由 OS 接管，不必 suppress
    suppressed: permissionsIntroOpen,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setInstallWaitExpired(true), 12000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (permissionsFlowStartedRef.current) return;
    permissionsFlowStartedRef.current = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await evaluateFirstLaunchPermissionFlow();
        if (result.action === 'show_intro') {
          setPermissionsIntroPending(true);
        }
      })();
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!permissionsIntroPending || permissionsIntroOpen) return;
    // 安装条正在展示时，不打断
    if (installPrompt.bannerReady) return;

    const canShowAfterPwa =
      !installPrompt.installEligible ||
      installPrompt.userDismissed ||
      installPrompt.installAttemptFinished ||
      (installWaitExpired && !installPrompt.bannerEverReady);

    if (!canShowAfterPwa) return;

    setPermissionsIntroOpen(true);
    setPermissionsIntroPending(false);
  }, [
    permissionsIntroPending,
    permissionsIntroOpen,
    installPrompt.bannerReady,
    installPrompt.installEligible,
    installPrompt.userDismissed,
    installPrompt.installAttemptFinished,
    installPrompt.bannerEverReady,
    installWaitExpired,
  ]);

  const finishPermissionsIntro = useCallback((runRequests: boolean) => {
    setPermissionsIntroOpen(false);
    markFirstLaunchPermissionIntroDone();
    if (runRequests) {
      setPermissionsRequesting(true);
      void requestAllPendingPermissions().finally(() => {
        setPermissionsRequesting(false);
      });
    }
  }, []);

  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      prevTabRef.current = activeTab;
      switchCountRef.current += 1;
      setFadeKey(switchCountRef.current);
    }
  }, [activeTab]);

  // 路由变化时标记 tab 为已访问
  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  // 监听路由变化，点击社区页面后隐藏红点
  // showBadge 已在 navItems 中固定为 false，无需额外状态管理
  // （原 setShowUnreadBadge 调用已删除，避免 ReferenceError 导致崩溃）

  // ---- PWA 冷启动检测（放在所有 hooks 之后，遵守 Rules of Hooks）----
  // standalone 模式下浏览器会恢复上次 URL（如 /home），跳过 / 的开屏页。
  // 用 sessionStorage 检测：新 session 且 standalone → 重定向到 / 显示开屏页。
  // sessionStorage 在 PWA 每次冷启动时为空（区别于 localStorage），完美区分冷/热启动。
  const needsSplash = (() => {
    try {
      if (sessionStorage.getItem(SPLASH_SHOWN_KEY)) return false;
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if ((navigator as any).standalone === true) return true;
    } catch {}
    return false;
  })();

  if (needsSplash) {
    return <Navigate to="/" replace />;
  }

  // 触摸开始时立即预加载页面，提升响应速度
  const handleTouchStart = (path: string) => {
    const preload = preloadMap[path];
    if (preload) {
      preload();
    }
  };

  const navItems = [
    { path: "/home", icon: Home, label: t.common.home },
    { path: "/home/market", icon: NotebookText, label: t.common.market },
    { path: "/home/community", icon: MessageCircle, label: t.common.community, showBadge: chatUnread > 0 },
    { path: "/home/profile", icon: User, label: t.common.profile },
  ];

  // Tab 页面配置
  const tabPages = [
    { key: "home", Component: HomePage },
    { key: "market", Component: MarketPage },
    { key: "community", Component: CommunityPage },
    { key: "profile", Component: ProfilePage },
  ] as const;

  // 底部导航栏：白色背景 + 阴影凸显，对低端设备友好
  const navBgClass = "bg-white";

  return (
    <div
      className="fixed inset-x-0 top-0 flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--app-bg)',
        /* 三层回退：JS精确值 → 100dvh(动态视口，排除工具栏) → 100vh(兜底) */
        height: 'var(--app-height, 100dvh)',
      }}
    >
      {/* 状态栏占位 — standalone 模式下用 safe-area-inset-top 撇开 */}
      <div className="bg-emerald-600 safe-top flex-shrink-0" />

      {/* 主内容 — Keep-alive: 所有已访问 tab 同存在 DOM 中，用 display 切 */}
      <main className="flex-1 overflow-hidden relative">
        {tabPages.map(({ key, Component }) => {
          const isActive = activeTab === key;
          const isMounted = mountedTabs.has(key);
          if (!isMounted) return null;
          // community 页面有自己的内部滚动，外层用 overflow-hidden
          // 防止 iOS 聚焦 input 时滚动外层容器导致页面跳顶
          const overflowClass = key === "community"
            ? "absolute inset-0 overflow-hidden"
            : "absolute inset-0 overflow-y-auto overflow-x-hidden";
          return (
            <div
              key={key}
              className={overflowClass}
              style={{
                display: isActive ? "block" : "none",
              }}
            >
              <Suspense fallback={TAB_SUSPENSE_FALLBACK[key]}>
                <Component />
              </Suspense>
            </div>
          );
        })}
      </main>

      {/* 底部导航 — 键盘弹出时隐藏，让聊天输入栏紧贴键盘 */}
      {!keyboardVisible && (
      <nav
        className={`flex-shrink-0 z-40 ${navBgClass} safe-bottom`}
        style={{ boxShadow: '0 -1px 12px rgba(0,0,0,0.06)' }}
        role="tablist"
        aria-label="Main navigation"
      >
        <div className="relative">
          <div className="flex items-center px-1 relative">
            {navItems.map((item) => {
              const dockActive = dockBasePath === item.path;
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  replace={settingsOpen}
                  role="tab"
                  aria-selected={dockActive}
                  aria-label={item.label}
                  className="flex items-center justify-center relative flex-1 min-w-0 max-w-[25%] pt-2 pb-1 select-none"
                  onTouchStart={() => handleTouchStart(item.path)}
                  style={{ WebkitTapHighlightColor: 'transparent', minHeight: '48px' }}
                >
                  {/* 图标 - 放大，无文字 */}
                  <div className="relative">
                    <Icon
                      className="w-7 h-7 transition-colors duration-200"
                      style={{ color: dockActive ? '#059669' : '#9ca3af' }}
                      strokeWidth={dockActive ? 2.2 : 1.8}
                    />

                    {/* 未读消息红点 - 带脉冲 */}
                    {item.showBadge && (
                      <span className={`absolute -top-0.5 ${isRTL ? '-left-1.5' : '-right-1.5'} flex h-2.5 w-2.5`}>
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-60" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500 ring-2 ring-white" />
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>


        </div>
      </nav>
      )}
      {settingsOpen && (
        <div className="fixed inset-0 z-[100]" style={{ height: "var(--app-height, 100dvh)" }}>
          <Suspense fallback={<SkeletonScreen />}>
            <SettingsPageLazy />
          </Suspense>
        </div>
      )}
      <PWAInstallBanner install={installPrompt} />
      <PermissionsIntroSheet
        open={permissionsIntroOpen}
        onContinue={() => finishPermissionsIntro(true)}
        onLater={() => finishPermissionsIntro(false)}
      />
    </div>
  );
}

/** 从 pathname 提取 tab key */
function getTabKey(pathname: string): string {
  if (pathname.startsWith("/home/market")) return "market";
  if (pathname.startsWith("/home/community")) return "community";
  if (pathname.startsWith("/home/profile")) return "profile";
  return "home";
}