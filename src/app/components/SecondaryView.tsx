import { ReactNode, useEffect, useState, useCallback } from "react";
import { X } from "lucide-react";
import { useKeyboardHeight } from "../hooks/useKeyboardHeight";
import { useLanguage } from "../hooks/useLanguage";
import { useBackHandler } from "../hooks/useBackHandler";

interface SecondaryViewProps {
  children: ReactNode;
  footer?: ReactNode;
  dockLeft?: ReactNode;
  dockRight?: ReactNode;
  headerRight?: ReactNode;
  onClose: () => void;
  title?: string;
  showTitle?: boolean;
  /**
   * 子内容区用 flex 撑满剩余高度（如全屏聊天：消息区滚动 + 底栏贴关闭条）。
   * 默认 false：整块内容在可滚动区域内（适合文章、表单等）。
   */
  fillContainer?: boolean;
  /** 为 true 时：底部关闭与系统返回不退出，仅触发 onCloseBlocked（如强制完善资料） */
  closeBlocked?: boolean;
  onCloseBlocked?: () => void;
}

/**
 * SecondaryView — 二级页面容器
 * 动画：从底部浮上来 translateY(100%) → translateY(0)
 * 纯 CSS transform，GPU 合成，十年前手机也流畅
 *
 * Android 返回键支持：
 *   监听 Escape 键（桌面）和 popstate（Android 返回键映射）。
 *   不主动调用 history.pushState / history.back()，
 *   避免与 React Router 的 history 管理冲突。
 */
export function SecondaryView({
  children,
  footer,
  dockLeft,
  dockRight,
  headerRight,
  onClose,
  title,
  showTitle = true,
  fillContainer = false,
  closeBlocked = false,
  onCloseBlocked,
}: SecondaryViewProps) {
  const [phase, setPhase] = useState<'entering' | 'visible' | 'leaving'>('entering');
  const { keyboardHeight, isKeyboardOpen } = useKeyboardHeight();
  const { isRTL } = useLanguage();

  const tryClose = useCallback(() => {
    if (closeBlocked) {
      onCloseBlocked?.();
      return;
    }
    setPhase('leaving');
  }, [closeBlocked, onCloseBlocked]);

  useEffect(() => {
    // 双帧确保浏览器完成首帧布局再触发过渡，低端设备也能稳定触发动画
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setPhase('visible'));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = useCallback(() => {
    tryClose();
  }, [tryClose]);

  // ── 系统返回手势 / 返回键支持 ──
  useBackHandler(handleClose);

  // ── Android 返回键 / Escape 键支持 ──
  useEffect(() => {
    // Escape 键（桌面浏览器、Android WebView 部分映射）
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        tryClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [tryClose]);

  const handleTransitionEnd = useCallback(() => {
    if (phase === 'leaving') onClose();
  }, [phase, onClose]);

  const off = phase !== 'visible';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Secondary view'}
      style={{
        backgroundColor: 'var(--app-bg)',
        // 键盘弹出时收缩底部，让 footer/input 紧贴键盘顶部
        bottom: isKeyboardOpen ? `${keyboardHeight}px` : '0px',
        transition: phase === 'leaving'
          ? 'transform 160ms ease-in, opacity 120ms ease-in'
          : 'transform 380ms cubic-bezier(0.16, 1, 0.3, 1), opacity 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        transform: phase === 'entering'
          ? 'scale(0.94) translateY(12px)'
          : phase === 'leaving'
            ? 'scale(0.97)'
            : 'none',
        opacity: off ? 0 : 1,
        willChange: off ? 'transform, opacity' : 'auto',
      }}
      onTransitionEnd={handleTransitionEnd}
    >
      {/* 状态栏占位 */}
      <div className="bg-emerald-600 safe-top flex-shrink-0" />

      {/* 内容区域 */}
      {fillContainer ? (
        <div
          className="flex-1 flex flex-col min-h-0 overflow-hidden overflow-x-hidden"
          style={{ backgroundColor: "var(--app-bg)" }}
        >
          {showTitle && title && (
            <div
              className="z-10 flex flex-shrink-0 items-center justify-center relative"
              style={{
                backgroundColor: "var(--app-bg)",
                boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
                padding: "clamp(12px, 3vh, 20px) clamp(16px, 4vw, 24px)",
                minHeight: "clamp(48px, 12vh, 64px)",
              }}
            >
              <h2
                className="font-bold text-gray-900 text-center truncate w-full px-2"
                style={{ fontSize: "clamp(13px, 4vw, 18px)" }}
              >
                {title}
              </h2>
              {headerRight && (
                <div
                  className={`absolute ${isRTL ? "left-4" : "right-4"} top-1/2`}
                  style={{ transform: "translateY(-50%)" }}
                >
                  {headerRight}
                </div>
              )}
            </div>
          )}
          <div
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            style={{ backgroundColor: "var(--app-bg)" }}
          >
            {children}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ backgroundColor: "var(--app-bg)" }}>
          {showTitle && title && (
            <div
              className="sticky top-0 z-10 flex items-center justify-center relative"
              style={{
                backgroundColor: "var(--app-bg)",
                boxShadow: "0 1px 8px rgba(0,0,0,0.06)",
                padding: "clamp(12px, 3vh, 20px) clamp(16px, 4vw, 24px)",
                minHeight: "clamp(48px, 12vh, 64px)",
              }}
            >
              <h2
                className="font-bold text-gray-900 text-center truncate w-full px-2"
                style={{ fontSize: "clamp(13px, 4vw, 18px)" }}
              >
                {title}
              </h2>
              {headerRight && (
                <div
                  className={`absolute ${isRTL ? "left-4" : "right-4"} top-1/2`}
                  style={{ transform: "translateY(-50%)" }}
                >
                  {headerRight}
                </div>
              )}
            </div>
          )}
          <div className="min-h-full" style={{ backgroundColor: "var(--app-bg)" }}>
            {children}
          </div>
        </div>
      )}

      {/* Footer — 固定在滚动区域下方、Dock栏上方 */}
      {footer && (
        <div className="flex-shrink-0" style={{ backgroundColor: 'var(--app-bg)' }}>
          {footer}
        </div>
      )}

      {/* Dock栏 — 键盘弹出时隐藏，节省空间让输入框紧贴键盘 */}
      {!isKeyboardOpen && (
        <nav
          className={`flex-shrink-0 bg-white safe-bottom ${fillContainer ? "border-t border-gray-100" : ""}`}
        >
          <div className="relative">
            <div className="flex items-center justify-center px-1 relative">
              {dockLeft && <div className={`absolute ${isRTL ? "right-4" : "left-4"}`}>{dockLeft}</div>}
              {dockRight && <div className={`absolute ${isRTL ? "left-4" : "right-4"}`}>{dockRight}</div>}
              <button
                type="button"
                onClick={handleClose}
                className={`flex items-center justify-center pb-1 active:scale-95 transition-transform touch-manipulation ${fillContainer ? "pt-1" : "pt-2"}`}
                aria-label={title ? `Close ${title}` : "Close"}
                style={{ minWidth: "48px", minHeight: "48px" }}
              >
                <X className="w-7 h-7 text-red-500" strokeWidth={2} />
              </button>
            </div>
          </div>
        </nav>
      )}
    </div>
  );
}