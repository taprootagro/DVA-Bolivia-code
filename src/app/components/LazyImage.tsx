import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";

interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  placeholder?: string;
}

/**
 * 懒加载图片组件 - 针对老设备优化
 * - 使用 Intersection Observer（滚动容器为 root，兼容 Virtuoso 等嵌套滚动）
 * - 缓存命中时检测 img.complete，避免 onLoad 不触发导致永久透明
 * - 加载失败显示回退占位图
 */

const PLACEHOLDER_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'%3E%3Crect width='400' height='300' fill='%23e5e7eb'/%3E%3C/svg%3E";

const ERROR_SVG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'%3E%3Crect width='400' height='300' fill='%23f3f4f6'/%3E%3Cpath d='M185 130 L215 130 L215 160 L185 160Z M195 140 L205 140 M200 145 L200 155 M180 170 L220 170' stroke='%23d1d5db' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E";

function findScrollRoot(el: HTMLElement | null): Element | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const { overflowY, overflow } = getComputedStyle(node);
    const oy = overflowY || overflow;
    if (
      (oy === "auto" || oy === "scroll" || oy === "overlay") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function isVisibleInRoot(el: HTMLElement, root: Element | null): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  if (!root) {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  const rootRect = root.getBoundingClientRect();
  return (
    rect.bottom > rootRect.top &&
    rect.top < rootRect.bottom &&
    rect.right > rootRect.left &&
    rect.left < rootRect.right
  );
}

export function LazyImage({
  src,
  alt,
  className = "",
  placeholder = PLACEHOLDER_SVG,
}: LazyImageProps) {
  const { resolve } = useCmsMediaUrl();
  const resolvedSrc = useMemo(() => resolve(src), [resolve, src]);
  const [imageSrc, setImageSrc] = useState(placeholder);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const srcRef = useRef(resolvedSrc);
  srcRef.current = resolvedSrc;

  const markLoadedIfComplete = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) {
      setImageLoaded(true);
      setHasError(false);
    }
  }, []);

  const beginLoad = useCallback(() => {
    const target = srcRef.current?.trim();
    if (!target) {
      setHasError(false);
      setImageSrc(ERROR_SVG);
      setImageLoaded(true);
      return;
    }
    setHasError(false);
    setImageLoaded(false);
    setImageSrc(target);
  }, []);

  const disconnectObserver = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  const setupObserver = useCallback(
    (el: HTMLImageElement | null) => {
      disconnectObserver();
      if (!el) return;

      const target = srcRef.current?.trim();
      if (!target) {
        setHasError(false);
        setImageSrc(ERROR_SVG);
        setImageLoaded(true);
        return;
      }

      if (!("IntersectionObserver" in window)) {
        beginLoad();
        return;
      }

      const root = findScrollRoot(el);

      if (isVisibleInRoot(el, root)) {
        beginLoad();
        return;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              beginLoad();
              observer.disconnect();
              if (observerRef.current === observer) {
                observerRef.current = null;
              }
              break;
            }
          }
        },
        { root, rootMargin: "80px", threshold: 0.01 },
      );

      observer.observe(el);
      observerRef.current = observer;
    },
    [beginLoad, disconnectObserver],
  );

  const setImgRef = useCallback(
    (el: HTMLImageElement | null) => {
      imgRef.current = el;
      setupObserver(el);
    },
    [setupObserver],
  );

  useEffect(() => {
    setHasError(false);
    setImageLoaded(false);
    setImageSrc(placeholder);
    setupObserver(imgRef.current);
    return disconnectObserver;
  }, [resolvedSrc, placeholder, setupObserver, disconnectObserver]);

  useLayoutEffect(() => {
    markLoadedIfComplete(imgRef.current);
  }, [imageSrc, markLoadedIfComplete]);

  const handleLoad = () => {
    setImageLoaded(true);
    setHasError(false);
  };

  const handleError = () => {
    if (!hasError) {
      setHasError(true);
      setImageSrc(ERROR_SVG);
      setImageLoaded(true);
    }
  };

  return (
    <img
      ref={setImgRef}
      src={imageSrc}
      alt={alt}
      className={`${className} ${imageLoaded ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}
      onLoad={handleLoad}
      onError={handleError}
      loading="lazy"
      decoding="async"
    />
  );
}
