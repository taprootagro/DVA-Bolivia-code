import { useState, useRef, useEffect, useCallback } from "react";
import { X, Share2, MapPin, Play, Loader2, Check } from "lucide-react";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";
import { useLanguage } from "../hooks/useLanguage";
import { CmsMediaImg } from "./CmsMediaImg";
import { convertCoord, type CoordSystem } from "../utils/coordTransform";
import { isWeChatBrowser, initWxSdk, setupWxShare } from "../utils/wxJsSdk";
import { useBackHandler } from "../hooks/useBackHandler";
import { buildEmbedPlaybackSrc, resolveLiveStreamEmbedUrl } from "../utils/videoEmbedFromUrl";
import { bridge } from "../utils/capacitor-bridge";

interface VideoFeedPageProps {
  onClose: () => void;
  startIndex?: number;
}

const EMBED_IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen";

// 视频 URL 列表从配置 (config.videoFeed.videoSources) 读取，
// 仅当配置无数据时使用空数组兜底，不再硬编码大量 Google Storage URL 在 JS bundle 中。
const FALLBACK_VIDEO_URLS: string[] = [];

export function VideoFeedPage({ onClose, startIndex = 0 }: VideoFeedPageProps) {
  const { config } = useConfigContext();
  const { resolve: resolveMedia } = useCmsMediaUrl();
  const { t } = useLanguage();
  const v = t.video;

  // 从配置获取直播流列表
  const liveStreams = config.liveStreams || [];

  // 全局分享/导航配置仅作为后备默认值
  const globalShareConfig = config.liveShareConfig;
  const globalNavConfig = config.liveNavigationConfig;

  // ── 获取当前视频的分享配置（优先使用视频自身配置，否则回退到全局配置） ──
  const getVideoShareConfig = (stream: typeof liveStreams[0]) => ({
    enabled: stream.shareEnabled ?? globalShareConfig?.enabled ?? true,
    shareUrl: stream.shareUrl || globalShareConfig?.shareUrl || '',
    shareTitle: stream.shareTitle || globalShareConfig?.shareTitle || 'TaprootAgro',
    shareText: stream.shareText || globalShareConfig?.shareText || '',
    shareImgUrl: stream.shareImgUrl || globalShareConfig?.shareImgUrl || '',
    wxJsSdkEnabled: stream.wxJsSdkEnabled ?? globalShareConfig?.wxJsSdkEnabled ?? false,
    wxAppId: stream.wxAppId || globalShareConfig?.wxAppId || '',
    wxSignatureApi: stream.wxSignatureApi || globalShareConfig?.wxSignatureApi || '',
  });

  // ── 获取当前视频的导航配置（优先使用视频自身配置，否则回退到全局配置） ──
  const getVideoNavConfig = (stream: typeof liveStreams[0]) => ({
    enabled: stream.navEnabled ?? globalNavConfig?.enabled ?? false,
    latitude: stream.navLatitude || globalNavConfig?.latitude || '0',
    longitude: stream.navLongitude || globalNavConfig?.longitude || '0',
    address: stream.navAddress || globalNavConfig?.address || '',
    coordSystem: (stream.navCoordSystem || globalNavConfig?.coordSystem || 'wgs84') as CoordSystem,
    displayDays: stream.navDisplayDays ?? 15,
    createdAt: stream.navCreatedAt ?? 0,
    baiduMap: stream.navBaiduMap ?? globalNavConfig?.baiduMap ?? true,
    amapMap: stream.navAmapMap ?? globalNavConfig?.amapMap ?? true,
    googleMap: stream.navGoogleMap ?? globalNavConfig?.googleMap ?? true,
    appleMaps: stream.navAppleMaps ?? globalNavConfig?.appleMaps ?? true,
    waze: stream.navWaze ?? globalNavConfig?.waze ?? true,
  });

  // ── 检查导航是否过期 ──
  const isNavExpired = (stream: typeof liveStreams[0]): boolean => {
    const navCfg = getVideoNavConfig(stream);
    if (!navCfg.enabled) return true;
    if (!navCfg.createdAt || navCfg.createdAt === 0) return false; // 没设置创建时间，永不过期
    const expireMs = navCfg.displayDays * 24 * 60 * 60 * 1000;
    return Date.now() > navCfg.createdAt + expireMs;
  };

  // ── 坐标转换辅助（基于当前视频的导航配置） ──
  const getCoordForStream = (stream: typeof liveStreams[0], target: CoordSystem): [number, number] => {
    const navCfg = getVideoNavConfig(stream);
    const rawLat = parseFloat(navCfg.latitude);
    const rawLng = parseFloat(navCfg.longitude);
    return convertCoord(rawLng, rawLat, navCfg.coordSystem, target);
  };

  // 从配置生成视频列表
  const videos = liveStreams.length > 0
    ? liveStreams.map((stream, index) => {
        const rawUrl = stream.videoUrl || FALLBACK_VIDEO_URLS[index % FALLBACK_VIDEO_URLS.length];
        const embedUrl = resolveLiveStreamEmbedUrl(rawUrl || "");
        return {
          id: stream.id,
          url: rawUrl,
          embedUrl: embedUrl || undefined,
          title: stream.title,
          thumbnail: stream.thumbnail,
          viewers: stream.viewers,
        };
      })
    : FALLBACK_VIDEO_URLS.slice(0, 3).map((url, index) => ({
        id: index + 1,
        url,
        embedUrl: undefined as string | undefined,
        title: `${v?.sampleVideo || '示例视频'} ${index + 1}`,
        thumbnail: "",
        viewers: "0",
      }));

  // 默认不自动播：首次点击屏幕后在用户手势内 play() + 取消静音，避免 iOS/Chrome 拦截有声自动播放
  const [currentIndex, setCurrentIndex] = useState(() => Math.min(startIndex, Math.max(0, (liveStreams.length > 0 ? liveStreams.length : 3) - 1)));
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [touchStart, setTouchStart] = useState(0);
  const [touchEnd, setTouchEnd] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  // P3 fix: removed showPlayIcon dead state
  const [loadingStates, setLoadingStates] = useState<Record<number, boolean>>({});
  const [errorStates, setErrorStates] = useState<Record<number, boolean>>({});

  // 分享 & 导航状态
  const [showNavSheet, setShowNavSheet] = useState(false);
  const [navSheetAnim, setNavSheetAnim] = useState<'entering' | 'visible' | 'leaving'>('entering');
  const [shareToast, setShareToast] = useState<string | null>(null);
  const wxInitRef = useRef(false);

  // 过渡动画状态
  const [animPhase, setAnimPhase] = useState<'entering' | 'visible' | 'leaving'>('entering');

  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimPhase('visible'));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 直播页全黑：临时将 body 背景改黑，防止 iPhone 安全区露白
  useEffect(() => {
    const prevBg = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#000000';
    return () => {
      document.body.style.backgroundColor = prevBg;
    };
  }, []);

  const handleCloseWithAnim = useCallback(() => {
    setAnimPhase('leaving');
  }, []);

  // ── 系统返回手势 / 返回键支持 ──
  useBackHandler(handleCloseWithAnim);

  const handleTransitionEnd = useCallback(() => {
    if (animPhase === 'leaving') onClose();
  }, [animPhase, onClose]);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const embedIframeRef = useRef<HTMLIFrameElement | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncEmbedIframeSrc = useCallback((embedUrl: string, autoplay: boolean) => {
    const iframe = embedIframeRef.current;
    if (!iframe) return;
    const next = buildEmbedPlaybackSrc(embedUrl, autoplay);
    if (iframe.src !== next) {
      iframe.src = next;
    }
  }, []);

  const currentEmbedUrl = videos[currentIndex]?.embedUrl;

  // 切流时重置播放态；嵌入 iframe 回到无 autoplay 的 src（不 remount）
  useEffect(() => {
    setIsPlaying(false);
    setIsMuted(true);
    if (currentEmbedUrl) {
      syncEmbedIframeSrc(currentEmbedUrl, false);
    }
  }, [currentIndex, currentEmbedUrl, syncEmbedIframeSrc]);

  // 标记视频加载状态
  const handleVideoCanPlay = useCallback((index: number) => {
    setLoadingStates(prev => ({ ...prev, [index]: false }));
  }, []);

  const handleVideoWaiting = useCallback((index: number) => {
    setLoadingStates(prev => ({ ...prev, [index]: true }));
  }, []);

  const handleVideoError = useCallback((index: number) => {
    setErrorStates(prev => ({ ...prev, [index]: true }));
    setLoadingStates(prev => ({ ...prev, [index]: false }));
  }, []);

  // 当前索引 / 播放状态变化：切流时同步播放；嵌入视频走 iframe，直链走 video 元素
  useEffect(() => {
    const currentVideoData = videos[currentIndex];
    if (currentVideoData?.embedUrl) return;

    const currentVideo = videoRefs.current[currentIndex];
    if (currentVideo) {
      setLoadingStates(prev => ({ ...prev, [currentIndex]: true }));

      videoRefs.current.forEach((video, index) => {
        if (video && index !== currentIndex) {
          video.pause();
          video.currentTime = 0;
        }
      });

      if (isPlaying) {
        if (currentVideo.paused) {
          currentVideo.play().then(() => {
            setLoadingStates(prev => ({ ...prev, [currentIndex]: false }));
          }).catch(() => {
            setIsPlaying(false);
            setLoadingStates(prev => ({ ...prev, [currentIndex]: false }));
          });
        } else {
          setLoadingStates(prev => ({ ...prev, [currentIndex]: false }));
        }
      } else {
        currentVideo.pause();
        setLoadingStates(prev => ({ ...prev, [currentIndex]: false }));
      }
    }
  }, [currentIndex, isPlaying, videos]);

  // P2 fix: 使用原生事件监听器处理 wheel，设置 {passive: false} 以正确 preventDefault
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelTimer.current) return;
      
      const threshold = 30;
      if (Math.abs(e.deltaY) > threshold) {
        if (e.deltaY > 0) {
          setCurrentIndex(prev => prev < videos.length - 1 ? prev + 1 : 0);
        } else {
          setCurrentIndex(prev => prev > 0 ? prev - 1 : videos.length - 1);
        }
        wheelTimer.current = setTimeout(() => {
          wheelTimer.current = null;
        }, 500);
      }
    };

    container.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleNativeWheel);
    };
  }, [videos.length]);

  // 处理触摸
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStart(e.targetTouches[0].clientY);
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;
    const currentTouch = e.targetTouches[0].clientY;
    setDragOffset(currentTouch - touchStart);
    setTouchEnd(currentTouch);
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    // ★ 只有 touchMove 真正被调用过（touchEnd 被设置过）才判断滑动
    // 纯 tap（无移动）时 touchEnd 保持为 0，不应触发视频切换
    if (touchEnd !== 0) {
      const diff = touchStart - touchEnd;
      const threshold = 50;

      if (Math.abs(diff) > threshold) {
        if (diff > 0) {
          setCurrentIndex(prev => prev < videos.length - 1 ? prev + 1 : 0);
        } else {
          setCurrentIndex(prev => prev > 0 ? prev - 1 : videos.length - 1);
        }
      }
    }
    
    setDragOffset(0);
    setTouchStart(0);
    setTouchEnd(0);
  };

  const togglePlay = () => {
    const currentVideoData = videos[currentIndex];
    if (currentVideoData?.embedUrl) {
      const embedUrl = currentVideoData.embedUrl;
      if (isPlaying) {
        syncEmbedIframeSrc(embedUrl, false);
        setIsPlaying(false);
        return;
      }
      // 必须在同一次用户手势内改 iframe.src，不可依赖 React key 重建 iframe
      syncEmbedIframeSrc(embedUrl, true);
      setIsMuted(false);
      setIsPlaying(true);
      return;
    }

    const currentVideo = videoRefs.current[currentIndex];
    if (!currentVideo) return;
    if (isPlaying) {
      currentVideo.pause();
      setIsPlaying(false);
      return;
    }
    setIsMuted(false);
    currentVideo.muted = false;
    setIsPlaying(true);
    currentVideo.play().catch(() => setIsPlaying(false));
  };

  // ── 微信 JS-SDK 初始化（使用当前视频的分享配置） ──
  useEffect(() => {
    if (!liveStreams.length || wxInitRef.current || !isWeChatBrowser()) return;
    const currentStream = liveStreams[currentIndex];
    if (!currentStream) return;
    const sc = getVideoShareConfig(currentStream);
    if (!sc.wxJsSdkEnabled || !sc.wxSignatureApi) return;

    wxInitRef.current = true;
    const url = sc.shareUrl || window.location.origin;
    const title = sc.shareTitle || "TaprootAgro";
    const desc = sc.shareText || "";
    const imgUrl = sc.shareImgUrl || "";

    initWxSdk(sc.wxSignatureApi)
      .then(() => {
        setupWxShare({ title, desc, link: url, imgUrl });
      })
      .catch((err) => {
        console.warn("[VideoFeed] 微信JS-SDK初始化失败:", err);
      });
  }, [currentIndex, liveStreams]);

  // ── 分享功能（基于当前视频的配置） ──
  const handleShare = async () => {
    const currentStream = liveStreams[currentIndex];
    if (!currentStream) return;
    const sc = getVideoShareConfig(currentStream);

    const url = sc.shareUrl || window.location.origin;
    const title = sc.shareTitle || "TaprootAgro";
    const text = sc.shareText || "";

    if (isWeChatBrowser() && sc.wxJsSdkEnabled && sc.wxSignatureApi) {
      setShareToast(v?.shareHint || "Tap ··· at top-right to share");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
      } catch (err) {
        if ((err as DOMException).name !== "AbortError") {
          fallbackCopy(url);
        }
      }
    } else {
      fallbackCopy(url);
    }
  };

  const fallbackCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setShareToast(v?.linkCopied || "Link copied");
    } catch {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setShareToast(v?.linkCopied || "Link copied");
    }
    setTimeout(() => setShareToast(null), 2000);
  };

  // ── 导航功能（基于当前视频的配置） ──
  const navPausedRef = useRef(false);

  const openNavSheet = () => {
    const currentVideoData = videos[currentIndex];
    if (!currentVideoData?.embedUrl) {
      const currentVideo = videoRefs.current[currentIndex];
      if (currentVideo && !currentVideo.paused) {
        currentVideo.pause();
        navPausedRef.current = true;
      }
    } else if (isPlaying && currentVideoData.embedUrl) {
      syncEmbedIframeSrc(currentVideoData.embedUrl, false);
      setIsPlaying(false);
      navPausedRef.current = true;
    }
    setShowNavSheet(true);
    setNavSheetAnim('entering');
    requestAnimationFrame(() => setNavSheetAnim('visible'));
  };

  const closeNavSheet = () => {
    if (navPausedRef.current) {
      const currentVideoData = videos[currentIndex];
      if (currentVideoData?.embedUrl) {
        syncEmbedIframeSrc(currentVideoData.embedUrl, true);
        setIsPlaying(true);
      } else {
        const currentVideo = videoRefs.current[currentIndex];
        if (currentVideo) {
          currentVideo.play().catch(() => {});
        }
      }
      navPausedRef.current = false;
    }
    setNavSheetAnim('leaving');
    setTimeout(() => setShowNavSheet(false), 200);
  };

  // 打开地图 URL：优先使用原生 Scheme 唤起 App，失败则降级到网页版
  const openMapUrl = async (nativeUrl: string, webUrl: string) => {
    let appOpened = false;

    const fallbackToWeb = () => {
      if (appOpened) return;
      appOpened = true;
      window.open(webUrl, '_blank', 'noopener');
    };

    // 2.5s 后仍未离开页面 → App 未安装或未响应，降级到网页版
    const webFallbackTimer = setTimeout(fallbackToWeb, 2500);

    // 监听页面隐藏 → 原生 App 成功唤起
    const onVisChange = () => {
      if (document.hidden) {
        appOpened = true;
        clearTimeout(webFallbackTimer);
        document.removeEventListener('visibilitychange', onVisChange);
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    try {
      const opened = await bridge.app.openUrl(nativeUrl);
      if (opened) return;
    } catch {
      // Capacitor 不可用
    }

    // 方式 B：PWA/Web 环境 → 尝试 location.href 原生 Scheme
    try {
      window.location.href = nativeUrl;
    } catch {
      // location.href 失败，直接降级
      fallbackToWeb();
    }

    // 3s 总超时：清理 visibility 监听
    setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisChange);
    }, 3000);
  };

  // 获取当前视频的导航地图选项
  const getCurrentMapOptions = () => {
    const currentStream = liveStreams[currentIndex];
    if (!currentStream) return [];
    const nc = getVideoNavConfig(currentStream);

    const mapOptions = [
      {
        key: "baiduMap",
        enabled: nc.baiduMap,
        label: v?.baiduMaps || "Baidu Maps",
        getUrl: () => {
          const [bdLng, bdLat] = getCoordForStream(currentStream, "bd09");
          const addr = encodeURIComponent(nc.address || "");
          return `https://api.map.baidu.com/marker?location=${bdLat},${bdLng}&title=${addr}&content=${addr}&output=html&coord_type=bd09ll&src=webapp.taprootagro`;
        },
        getNativeUrl: () => {
          const [bdLng, bdLat] = getCoordForStream(currentStream, "bd09");
          const addr = encodeURIComponent(nc.address || "");
          return `baidumap://map/marker?location=${bdLat},${bdLng}&title=${addr}&content=${addr}&coord_type=bd09ll&src=webapp.taprootagro`;
        },
      },
      {
        key: "amapMap",
        enabled: nc.amapMap,
        label: v?.amapMaps || "Amap",
        getUrl: () => {
          const [gcjLng, gcjLat] = getCoordForStream(currentStream, "gcj02");
          const addr = encodeURIComponent(nc.address || "");
          return `https://uri.amap.com/marker?position=${gcjLng},${gcjLat}&name=${addr}&src=webapp.taprootagro&coordinate=gaode&callnative=1`;
        },
        getNativeUrl: () => {
          const [gcjLng, gcjLat] = getCoordForStream(currentStream, "gcj02");
          const addr = encodeURIComponent(nc.address || "");
          // iOS: iosamap:// Android: 高德也支持 https://uri.amap.com 的 callnative 参数
          return `iosamap://path?sourceApplication=taprootagro&sid=&dlat=${gcjLat}&dlon=${gcjLng}&dname=${addr}&dev=0&t=0`;
        },
      },
      {
        key: "googleMap",
        enabled: nc.googleMap,
        label: "Google Maps",
        getUrl: () => {
          const [wLng, wLat] = getCoordForStream(currentStream, "wgs84");
          return `https://www.google.com/maps/dir/?api=1&destination=${wLat},${wLng}`;
        },
        getNativeUrl: () => {
          const [wLng, wLat] = getCoordForStream(currentStream, "wgs84");
          return `comgooglemaps://?daddr=${wLat},${wLng}&directionsmode=driving`;
        },
      },
      {
        key: "appleMaps",
        enabled: nc.appleMaps,
        label: "Apple Maps",
        getUrl: () => {
          const [wLng, wLat] = getCoordForStream(currentStream, "wgs84");
          const addr = encodeURIComponent(nc.address || "");
          return `https://maps.apple.com/?daddr=${wLat},${wLng}&dirflg=d&t=m&q=${addr}`;
        },
        getNativeUrl: () => {
          const [wLng, wLat] = getCoordForStream(currentStream, "wgs84");
          const addr = encodeURIComponent(nc.address || "");
          return `maps://?daddr=${wLat},${wLng}&dirflg=d&t=m&q=${encodeURIComponent(addr)}`;
        },
      },
      {
        key: "waze",
        enabled: nc.waze,
        label: "Waze",
        getUrl: () => {
          const [wLng, wLat] = getCoordForStream(currentStream, "wgs84");
          return `https://waze.com/ul?ll=${wLat},${wLng}&navigate=yes`;
        },
        getNativeUrl: () => {
          const [wLng, wLat] = getCoordForStream(currentStream, "wgs84");
          return `waze://?ll=${wLat},${wLng}&navigate=yes`;
        },
      },
    ];

    return mapOptions.filter((m) => m.enabled);
  };

  return (
    <div
      ref={containerRef}
      onTransitionEnd={handleTransitionEnd}
      className="fixed inset-0 z-50 bg-black overflow-hidden flex flex-col"
      style={{
        transform: animPhase === 'visible' ? 'none' : 'scale(0.97)',
        opacity: animPhase === 'visible' ? 1 : 0,
        transition: animPhase === 'leaving'
          ? 'transform 160ms ease-in, opacity 120ms ease-in'
          : 'transform 280ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out',
        willChange: animPhase === 'visible' ? 'auto' : 'transform, opacity',
      }}
    >
      {/* 视频容器 */}
      <div
        className="relative flex-1 w-full overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {videos.map((video, index) => {
          const offset = (index - currentIndex) * 100 + (isDragging ? (dragOffset / window.innerHeight) * 100 : 0);
          const isVisible = Math.abs(index - currentIndex) <= 1;
          const isCurrent = index === currentIndex;
          const isLoading = loadingStates[index];
          const hasError = errorStates[index];

          // 获取当前视频的分享/导航配置
          const currentStream = liveStreams[index];
          const videoShareCfg = currentStream ? getVideoShareConfig(currentStream) : null;
          const videoNavCfg = currentStream ? getVideoNavConfig(currentStream) : null;
          const navExpired = currentStream ? isNavExpired(currentStream) : true;
          const videoEnabledMaps = currentStream ? (() => {
            const nc = getVideoNavConfig(currentStream);
            const maps = [
              { key: "baiduMap", enabled: nc.baiduMap },
              { key: "amapMap", enabled: nc.amapMap },
              { key: "googleMap", enabled: nc.googleMap },
              { key: "appleMaps", enabled: nc.appleMaps },
              { key: "waze", enabled: nc.waze },
            ];
            return maps.filter(m => m.enabled);
          })() : [];
          const showShareBtn = videoShareCfg?.enabled !== false;
          const showNavBtn = videoNavCfg?.enabled && !navExpired && videoEnabledMaps.length > 0;

          return (
            <div
              key={video.id}
              className="absolute inset-0 w-full h-full transition-all duration-300 ease-out"
              style={{
                transform: `translateY(${offset}%)`,
                opacity: isCurrent ? 1 : 0.3,
                pointerEvents: isCurrent ? "auto" : "none",
              }}
            >
              {isVisible && (
                <div className="relative w-full h-full bg-black">
                  {/* 缩略图背景（视频加载前显示） */}
                  {video.thumbnail && (
                    <CmsMediaImg
                      src={video.thumbnail}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm"
                    />
                  )}

                  {/* 视频播放器：嵌入（YouTube/Vimeo/B站）或直链 MP4 */}
                  {video.embedUrl ? (
                    isCurrent && (
                      <>
                        <iframe
                          ref={isCurrent ? embedIframeRef : undefined}
                          key={video.id}
                          src={buildEmbedPlaybackSrc(video.embedUrl, false)}
                          title={video.title}
                          className={`video-feed-embed relative w-full h-full z-[1] border-0 ${isPlaying ? "pointer-events-auto" : "pointer-events-none"}`}
                          allow={EMBED_IFRAME_ALLOW}
                          allowFullScreen
                          referrerPolicy="strict-origin-when-cross-origin"
                        />
                        {!isPlaying && (
                          <button
                            type="button"
                            className="absolute inset-0 flex items-center justify-center z-10"
                            onClick={togglePlay}
                            aria-label={v?.sampleVideo || "Play"}
                          >
                            <div className="w-20 h-20 bg-black/50 rounded-full flex items-center justify-center pointer-events-none">
                              <Play className="w-10 h-10 text-white ms-1" fill="white" />
                            </div>
                          </button>
                        )}
                      </>
                    )
                  ) : (
                    <>
                      <video
                        ref={(el) => (videoRefs.current[index] = el)}
                        src={resolveMedia(video.url)}
                        poster={video.thumbnail ? resolveMedia(video.thumbnail) : undefined}
                        className="relative w-full h-full object-contain z-[1]"
                        loop
                        playsInline
                        muted={isMuted}
                        preload={isCurrent ? "auto" : "none"}
                        onClick={togglePlay}
                        onCanPlay={() => handleVideoCanPlay(index)}
                        onWaiting={() => handleVideoWaiting(index)}
                        onError={() => handleVideoError(index)}
                      />

                      {/* 加载指示器 */}
                      {isLoading && isCurrent && !hasError && (
                        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                          <Loader2 className="w-10 h-10 text-white animate-spin" />
                        </div>
                      )}

                      {/* 错误提示 */}
                      {hasError && isCurrent && (
                        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
                          <div className="flex flex-col items-center gap-3 bg-black/70 px-6 py-4 rounded-2xl">
                            <Play className="w-10 h-10 text-white/60" />
                            <span className="text-white/80 text-sm">{v?.loadFailed || '视频加载失败'}</span>
                            <span className="text-white/50 text-xs">{v?.checkVideoUrl || '请检查视频URL是否有效'}</span>
                          </div>
                        </div>
                      )}

                      {/* 暂停指示器 */}
                      {!isPlaying && isCurrent && !isLoading && !hasError && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                          <div className="w-20 h-20 bg-black/50 rounded-full flex items-center justify-center">
                            <Play className="w-10 h-10 text-white ms-1" fill="white" />
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* 视频信息和互动区域 */}
                  <div className="absolute bottom-0 left-0 right-0 pb-4 px-4 pt-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10">
                    <div className="flex items-end gap-3">
                      {/* 左侧信息区 */}
                      <div className="flex-1 space-y-2 min-w-0">
                        <h3 className="text-white font-semibold text-base drop-shadow-lg">
                          {video.title}
                        </h3>
                        <div className="flex items-center gap-2 text-white/80 text-xs">
                          <span>{(v?.views || '{count} 观看').replace('{count}', video.viewers)}</span>
                        </div>
                      </div>

                      {/* 右侧互动按钮 - 基于每个视频独立配置
                           ★ onTouchStart stopPropagation 阻止触摸事件冒泡到滑动容器 */}
                      <div
                        className="flex flex-col items-center gap-4 pb-1 flex-shrink-0"
                        onTouchStart={(e) => e.stopPropagation()}
                        onTouchMove={(e) => e.stopPropagation()}
                        onTouchEnd={(e) => e.stopPropagation()}
                      >
                        {showShareBtn && (
                        <button onClick={handleShare} className="flex flex-col items-center active:scale-95 transition-transform">
                          <div className="w-11 h-11 bg-white/30 rounded-full flex items-center justify-center border border-white/20">
                            <Share2 className="w-5 h-5 text-white" />
                          </div>
                        </button>
                        )}

                        {showNavBtn && (
                        <button
                          onClick={openNavSheet}
                          className="flex flex-col items-center active:scale-95 transition-transform"
                        >
                          <div className="w-11 h-11 bg-emerald-600/95 rounded-full flex items-center justify-center border border-emerald-400/30 shadow-lg">
                            <MapPin className="w-5 h-5 text-white" />
                          </div>
                        </button>
                        )}
                      </div>
                    </div>
                  </div>

                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 进度指示器 */}
      <div className="absolute ltr:right-2 rtl:left-2 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-20">
        {videos.map((_, index) => (
          <div
            key={index}
            className={`w-1 h-6 rounded-full transition-all duration-300 ${
              index === currentIndex
                ? "bg-emerald-500 shadow-lg"
                : "bg-white/40"
            }`}
          />
        ))}
      </div>

      {/* 底部Dock栏 - 直播页全���背景，安全区大幅削减让关闭按钮更贴底 */}
      <div
        className="flex-shrink-0 bg-black border-t border-white/10 z-20 safe-bottom"
      >
        <div className="flex justify-center items-center pt-1 pb-0">
          <button
            onClick={handleCloseWithAnim}
            className="flex items-center justify-center p-2 active:scale-95 transition-transform"
            aria-label={v?.close || '关闭'}
          >
            <X className="w-7 h-7 text-red-500" />
          </button>
        </div>
      </div>

      {/* ── 分享提示 Toast ── */}
      {shareToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-gray-800 text-white px-5 py-2.5 rounded-full text-sm flex items-center gap-2 shadow-xl animate-[fadeInUp_0.2s_ease-out]">
          <Check className="w-4 h-4 text-emerald-400" />
          {shareToast}
        </div>
      )}

      {/* ── 导航选择 Action Sheet ── */}
      {showNavSheet && (() => {
        const enabledMaps = getCurrentMapOptions();
        const currentStream = liveStreams[currentIndex];
        const nc = currentStream ? getVideoNavConfig(currentStream) : null;
        return (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) closeNavSheet(); }}
          style={{
            backgroundColor: navSheetAnim === 'visible' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0)',
            transition: 'background-color 200ms ease-out',
          }}
        >
          <div
            className="w-full max-w-lg mx-2 mb-2 safe-bottom"
            style={{
              transform: navSheetAnim === 'visible' ? 'translateY(0)' : 'translateY(100%)',
              opacity: navSheetAnim === 'leaving' ? 0 : 1,
              transition: navSheetAnim === 'leaving'
                ? 'transform 200ms ease-in, opacity 150ms ease-in'
                : 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
            }}
          >
            <div className="bg-white rounded-2xl overflow-hidden shadow-xl">
              <div className="px-4 pt-4 pb-2 text-center">
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <MapPin className="w-4 h-4 text-emerald-600" />
                  <p className="text-gray-800 text-sm">{v?.chooseNavApp || "Choose Navigation App"}</p>
                </div>
                {nc?.address && (
                  <p className="text-gray-400 text-xs truncate px-4">{nc.address}</p>
                )}
                <p className="text-gray-300 text-[10px] mt-1">
                  {`Coord: ${(nc?.coordSystem || 'wgs84').toUpperCase()} (auto-converted)`}
                </p>
              </div>

              {enabledMaps.map((map) => (
                <button
                  key={map.key}
                  className="w-full flex items-center justify-center gap-3 py-4 active:bg-gray-50 transition-colors"
                  style={{ boxShadow: '0 -1px 0 rgba(0,0,0,0.04)' }}
                  onClick={() => {
                    closeNavSheet();
                    const nativeUrl = map.getNativeUrl();
                    const webUrl = map.getUrl();
                    setTimeout(() => {
                      openMapUrl(nativeUrl, webUrl);
                    }, 220);
                  }}
                >
                  <span className="text-emerald-600" style={{ fontSize: '17px' }}>
                    {map.label}
                  </span>
                </button>
              ))}
            </div>

            <div className="bg-white rounded-2xl overflow-hidden shadow-xl mt-2">
              <button
                className="w-full py-4 active:bg-gray-50 transition-colors"
                onClick={closeNavSheet}
              >
                <span className="text-gray-600 font-medium" style={{ fontSize: '17px' }}>
                  {t.common.cancel || "Cancel"}
                </span>
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

export default VideoFeedPage;