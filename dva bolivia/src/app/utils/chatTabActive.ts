import { useEffect, useState } from "react";
import { bridge, isNative } from "./capacitor-bridge";

const ACTIVE_TAB_EVENT = "taproot-active-tab";

let currentTabKey = "home";
let appIsActive = true;

/** Layout 切换 Dock Tab 时广播，供聊天未读判断「community 是否激活」 */
export function setActiveTab(key: string): void {
  if (typeof window === "undefined") return;
  currentTabKey = key;
  window.dispatchEvent(new CustomEvent(ACTIVE_TAB_EVENT, { detail: key }));
}

export function getActiveTabKey(): string {
  return currentTabKey;
}

export function getAppIsActive(): boolean {
  return appIsActive;
}

/**
 * community Tab 是否处于「用户正在看」状态：
 * - Web/PWA：community Tab + document 可见
 * - 原生：community Tab + App 前台（appStateChange）
 */
export function useIsCommunityActive(): boolean {
  const [activeTab, setActiveTabState] = useState(currentTabKey);
  const [docVisible, setDocVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [nativeActive, setNativeActive] = useState(appIsActive);

  useEffect(() => {
    const onTab = (e: Event) => {
      const k = (e as CustomEvent<string>).detail;
      if (typeof k === "string") setActiveTabState(k);
    };
    window.addEventListener(ACTIVE_TAB_EVENT, onTab);
    return () => window.removeEventListener(ACTIVE_TAB_EVENT, onTab);
  }, []);

  useEffect(() => {
    if (isNative()) {
      let cancelled = false;
      let cleanup: (() => void) | null = null;
      void bridge.app.onStateChange((state) => {
        appIsActive = state.isActive;
        setNativeActive(state.isActive);
      }).then((fn) => {
        // 快速卸载时立即回收，避免 appStateChange listener 泄漏
        if (cancelled) {
          fn();
          return;
        }
        cleanup = fn;
      });
      return () => {
        cancelled = true;
        cleanup?.();
      };
    }

    const onVis = () => {
      const v = document.visibilityState === "visible";
      appIsActive = v;
      setDocVisible(v);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const foreground = isNative() ? nativeActive : docVisible;
  return activeTab === "community" && foreground;
}
