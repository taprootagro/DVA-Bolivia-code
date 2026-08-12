import { createBrowserRouter, Navigate } from "react-router";
import { lazy, Suspense } from "react";
import { Root } from "./components/Root";
import { Layout } from "./components/Layout";
import { SplashScreen } from "./components/SplashScreen";
import {
  SkeletonScreen,
} from "./components/SkeletonScreen";

// 懒加载页面组件 - 按需加载,减少首次加载体积
// 注意: 主 tab 页面（Home/Market/Community/Profile）已由 Layout.tsx 内部 keep-alive 管理
const LoginPage = lazy(() => import("./components/LoginPage"));
const ConfigManagerGate = lazy(() => import("./components/ConfigManagerGate").then((m) => ({ default: m.ConfigManagerGate })));
const OAuthCallback = lazy(() => import("./components/OAuthCallback"));

export function preloadMainPages() {
  // 使用 requestIdleCallback 在浏览器空闲时预加载，不影响主线程性能
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => {
      import("./components/MarketPage");
      import("./components/CommunityPage");
      import("./components/ProfilePage");
    });
  } else {
    // 降级方案：使用 setTimeout
    setTimeout(() => {
      import("./components/MarketPage");
      import("./components/CommunityPage");
      import("./components/ProfilePage");
    }, 1000);
  }
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      {
        index: true,
        Component: SplashScreen,
      },
      {
        path: "login",
        element: (
          <Suspense fallback={<SkeletonScreen />}>
            <LoginPage />
          </Suspense>
        ),
      },
      {
        path: "auth/callback",
        element: (
          <Suspense fallback={<SkeletonScreen />}>
            <OAuthCallback />
          </Suspense>
        ),
      },
      {
        // Keep-alive 模式：Layout 内部渲染所有 tab 页面，不再需要子路由
        path: "home/*",
        Component: Layout,
      },
      {
        path: "settings",
        element: <Navigate to="/home/settings" replace />,
      },
      {
        path: "config-manager",
        element: (
          <Suspense fallback={<SkeletonScreen />}>
            <ConfigManagerGate />
          </Suspense>
        ),
      },
      {
        path: "sw-reset",
        // Handled by Service Worker — render nothing so React Router doesn't 404
        element: null,
      },
      {
        path: "*",
        // Catch-all: redirect unknown routes to splash
        element: null,
        loader: () => {
          // If not handled by SW, redirect to root
          if (typeof window !== 'undefined') {
            window.location.replace('/');
          }
          return null;
        },
      },
    ],
  },
]);