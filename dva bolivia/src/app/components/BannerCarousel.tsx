import { useState, useEffect, useRef, useCallback, Children } from "react";

interface BannerCarouselProps {
  children: React.ReactNode;
  autoplay?: boolean;
  autoplaySpeed?: number;
  speed?: number;
  dots?: boolean;
  infinite?: boolean;
  pauseOnHover?: boolean;
  fade?: boolean;
  [key: string]: any; // allow extra props to be passed through without TS errors
}

export function BannerCarousel({
  children,
  autoplay = true,
  autoplaySpeed = 5000,
  speed = 800,
  dots = true,
  infinite = true,
  pauseOnHover = true,
  fade = true,
}: BannerCarouselProps) {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  const slides = Children.toArray(children);
  const total = slides.length;

  const goTo = useCallback(
    (index: number) => {
      if (infinite) {
        setCurrent(((index % total) + total) % total);
      } else {
        setCurrent(Math.max(0, Math.min(index, total - 1)));
      }
    },
    [total, infinite]
  );

  // Autoplay — pause when page is hidden (tab switch / screen off)
  useEffect(() => {
    if (!autoplay || paused || total <= 1) return;

    // Check if page is currently visible
    if (document.hidden) return;

    timerRef.current = setTimeout(() => goTo(current + 1), autoplaySpeed);

    const handleVisibility = () => {
      if (document.hidden) {
        if (timerRef.current) clearTimeout(timerRef.current);
      } else {
        timerRef.current = setTimeout(() => goTo(current + 1), autoplaySpeed);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [current, autoplay, autoplaySpeed, paused, total, goTo]);

  // Touch swipe
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchEndX.current = e.touches[0].clientX; // 重置，避免tap时残留旧值导致意外切换
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = () => {
    const diff = touchStartX.current - touchEndX.current;
    if (Math.abs(diff) > 50) {
      goTo(diff > 0 ? current + 1 : current - 1);
    }
  };

  if (total === 0) return null;

  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      onMouseEnter={() => pauseOnHover && setPaused(true)}
      onMouseLeave={() => pauseOnHover && setPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Slides */}
      {fade ? (
        // Fade mode
        slides.map((child, i) => (
          <div
            key={i}
            className="absolute inset-0 w-full h-full"
            style={{
              opacity: i === current ? 1 : 0,
              transition: `opacity ${speed}ms ease-in-out`,
              zIndex: i === current ? 1 : 0,
              pointerEvents: i === current ? "auto" : "none",
            }}
          >
            {child}
          </div>
        ))
      ) : (
        // Slide mode
        <div
          className="flex h-full"
          style={{
            transform: `translateX(-${current * 100}%)`,
            transition: `transform ${speed}ms ease-in-out`,
          }}
        >
          {slides.map((child, i) => (
            <div key={i} className="w-full h-full flex-shrink-0">
              {child}
            </div>
          ))}
        </div>
      )}

      {/* Dots */}
      {dots && total > 1 && (
        <div className="absolute bottom-2.5 inset-x-0 z-10 flex justify-center gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                goTo(i);
              }}
              className={`rounded-full transition-all duration-300 min-w-[24px] min-h-[24px] flex items-center justify-center`}
              aria-label={`Slide ${i + 1}`}
            >
              <span
                className={`rounded-full transition-all duration-300 ${
                  i === current ? "w-3 h-2 bg-white" : "w-2 h-2 bg-white/50"
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default BannerCarousel;