import { useEffect, useRef } from 'react';
import { bridge, isNative } from '../utils/capacitor-bridge';

/**
 * useBackHandler — Android 系统返回手势 / 返回键统一处理
 *
 * 架构设计：
 *   全局维护一个 handler 栈（LIFO）。当用户按下返回时，栈顶 handler 被调用。
 *   - Capacitor 原生：通过 @capacitor/app 的 backButton 事件触发
 *   - PWA / 浏览器：通过 history.pushState + popstate 事件触发
 *
 * 使用场景：
 *   1. 覆盖层（SecondaryView、VideoFeedPage 等）→ useBackHandler(onClose)
 *      - pushHistory=true（默认），会推入浏览器历史条目
 *      - 返回时关闭覆盖层
 *   2. Dock 层级（Layout）→ useBackHandler(handler, false)
 *      - pushHistory=false，不推入历史条目
 *      - 非首页 tab → 回到首页；首页 → 退出 app
 *
 * 当栈为空时（例如在 /settings、/login 等路由页面），
 * Capacitor backButton 的默认行为是 history.back()，
 * 由 React Router 正常处理路由回退。
 */

// ── Global state ──────────────────────────────────────────────────

type StackEntry = {
  id: symbol;
  handler: () => void;
  hasHistoryEntry: boolean;
};

const stack: StackEntry[] = [];
let initialized = false;
let suppressPopstateCount = 0;

/** 调用栈顶 handler */
function dispatchBack() {
  if (stack.length === 0) return false;
  const top = stack[stack.length - 1];
  top.handler();
  return true;
}

function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  // ── Web / PWA: popstate 监听 ──
  window.addEventListener('popstate', () => {
    // 被 suppress 的 popstate（由 cleanup 中的 history.back() 触发）直接跳过
    if (suppressPopstateCount > 0) {
      suppressPopstateCount--;
      return;
    }
    // 仅当存在推过历史条目的覆盖层 handler 时才拦截
    // 否则让 React Router 自然处理路由回退
    const hasOverlay = stack.some(e => e.hasHistoryEntry);
    if (hasOverlay) {
      dispatchBack();
    }
  });

  // ── Capacitor 原生: App 插件 backButton 事件 ──
  if (isNative()) {
    void bridge.app.onBackButton(() => {
      if (!dispatchBack()) {
        history.back();
      }
    });
  }
}

// ── Public hook ──────────────────────────────────────────────────

/**
 * 注册返回处理器。
 *
 * @param onBack      - 返回时执行的回调（通常是关闭覆盖层 / 切换 tab）
 * @param pushHistory - 是否推入浏览器历史条目（默认 true）。
 *                      覆盖层设为 true，dock 层级设为 false。
 */
export function useBackHandler(onBack: () => void, pushHistory = true) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const closedByBackRef = useRef(false);
  const prevStateRef = useRef<any>(null);

  useEffect(() => {
    ensureInitialized();
    closedByBackRef.current = false;

    const id = Symbol();
    const entry: StackEntry = {
      id,
      handler: () => {
        closedByBackRef.current = true;
        const idx = stack.findIndex(e => e.id === id);
        if (idx !== -1) stack.splice(idx, 1);
        onBackRef.current();
      },
      hasHistoryEntry: pushHistory,
    };

    stack.push(entry);

    if (pushHistory) {
      prevStateRef.current = history.state;
      history.pushState({ __backOverlay: true }, '');
    }

    return () => {
      const idx = stack.findIndex(e => e.id === id);
      if (idx !== -1) stack.splice(idx, 1);

      // 用户点 X 关闭（非系统返回）时，需要清理我们 push 的历史条目。
      // 不用 history.back() —— 它会触发 popstate 导致 React Router
      // 错误导航，在 standalone PWA 下甚至会退出应用。
      // 改用 replaceState 安全地把 overlay 条目覆盖回原始状态。
      if (pushHistory && !closedByBackRef.current) {
        if (history.state?.__backOverlay) {
          history.replaceState(prevStateRef.current, '');
        } else {
          suppressPopstateCount++;
          history.back();
        }
      }
    };
  }, []);
}
