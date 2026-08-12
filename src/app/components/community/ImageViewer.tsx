import { useState, useRef, useCallback, useEffect } from "react";
import { X } from "lucide-react";

interface ImageViewerProps {
  src: string;
  onClose: () => void;
}

/**
 * ImageViewer — 全屏图片查看器
 * 关闭按钮在底部（与 SecondaryView 一致的操作逻辑）
 * 支持双指缩放（pinch-to-zoom）、双击放大/复位
 */
export function ImageViewer({ src, onClose }: ImageViewerProps) {
  const [phase, setPhase] = useState<"entering" | "visible" | "leaving">("entering");
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const lastDistRef = useRef(0);
  const lastScaleRef = useRef(1);
  const panStartRef = useRef({ x: 0, y: 0 });
  const lastTranslateRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const lastTapRef = useRef(0);
  const didInteractRef = useRef(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setPhase("visible"));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = useCallback(() => {
    setPhase("leaving");
  }, []);

  const handleTransitionEnd = useCallback(() => {
    if (phase === "leaving") onClose();
  }, [phase, onClose]);

  const handleDoubleTap = useCallback(() => {
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
      lastScaleRef.current = 1;
      lastTranslateRef.current = { x: 0, y: 0 };
    } else {
      setScale(2.5);
      lastScaleRef.current = 2.5;
    }
  }, [scale]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      didInteractRef.current = true;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastDistRef.current = Math.sqrt(dx * dx + dy * dy);
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        didInteractRef.current = true;
        handleDoubleTap();
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;

      if (lastScaleRef.current > 1) {
        didInteractRef.current = true;
        isPanningRef.current = true;
        panStartRef.current = {
          x: e.touches[0].clientX - lastTranslateRef.current.x,
          y: e.touches[0].clientY - lastTranslateRef.current.y,
        };
      }
    }
  }, [handleDoubleTap]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastDistRef.current > 0) {
        const newScale = Math.max(0.5, Math.min(5, lastScaleRef.current * (dist / lastDistRef.current)));
        setScale(newScale);
      }
    } else if (e.touches.length === 1 && isPanningRef.current) {
      const newX = e.touches[0].clientX - panStartRef.current.x;
      const newY = e.touches[0].clientY - panStartRef.current.y;
      setTranslate({ x: newX, y: newY });
    }
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2 && lastDistRef.current > 0) {
      lastScaleRef.current = scale;
      lastDistRef.current = 0;
      if (scale < 1) {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
        lastScaleRef.current = 1;
        lastTranslateRef.current = { x: 0, y: 0 };
      }
    }
    if (e.touches.length === 0 && isPanningRef.current) {
      isPanningRef.current = false;
      lastTranslateRef.current = translate;
    }
  }, [scale, translate]);

  // Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const isOff = phase !== "visible";

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      style={{
        backgroundColor: isOff ? "rgba(0,0,0,0)" : "rgba(0,0,0,0.95)",
        transition: "background-color 250ms ease",
      }}
      onTransitionEnd={handleTransitionEnd}
    >
      {/* 图片区域 — 占满整个屏幕 */}
      <div className="flex-1 flex items-center justify-center min-h-0 overflow-hidden">
        <div
          className="max-w-[95vw] max-h-[85vh] select-none"
          style={{
            transform: `scale(${isOff ? 0.8 : scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
            opacity: isOff ? 0 : 1,
            transition: isOff
              ? "transform 200ms ease-in, opacity 150ms ease-in"
              : isPanningRef.current || lastDistRef.current > 0
                ? "none"
                : "transform 200ms ease-out, opacity 250ms ease-out",
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <img
            src={src}
            alt=""
            className="max-w-[95vw] max-h-[85vh] object-contain rounded-lg select-none pointer-events-none"
            draggable={false}
          />
        </div>
      </div>

      {/* 底部关闭按钮 — 固定在屏幕底部，不随图片变化 */}
      <div
        className="absolute left-0 right-0 bottom-0 flex items-center justify-center pb-[env(safe-area-inset-bottom,0px)]"
        style={{
          opacity: isOff ? 0 : 1,
          transition: "opacity 200ms ease",
        }}
      >
        <button
          onClick={handleClose}
          className="flex items-center justify-center mb-4 active:scale-95 transition-transform touch-manipulation"
          style={{ width: "48px", height: "48px" }}
        >
          <X className="w-7 h-7 text-red-500" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}