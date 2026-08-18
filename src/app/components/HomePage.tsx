import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, lazy, Suspense, startTransition } from "react";
import { useNavigate } from "react-router";
import { HomePageSecondaryLazySkeleton } from "./SkeletonScreen";
import { Search, ScanLine, Bot, Calculator, X, Loader2 } from "lucide-react";
import { ensureEdgeSessionReadyDetailed, isUserLoggedIn, isServerAssignedId } from "../utils/auth";
import { cloudAIUsesBackend } from "../services/CloudAIService";
import { BannerCarousel } from "./BannerCarousel";
import { usePerformanceMonitor } from "../hooks/usePerformanceMonitor";
import { useLanguage } from "../hooks/useLanguage";
import { LazyImage } from "./LazyImage";
import { CmsMediaImg } from "./CmsMediaImg";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";
import { useConfigContext } from "../hooks/ConfigProvider";
import { defaultConfig } from "/taprootagrosetting";
import { useNetworkQuality } from "../hooks/useNetworkQuality";
import { QRScannerCapture } from "./QRScannerCapture";

// 二级页面懒加载 — 这些页面仅在用户点击时才加载，避免首屏包体积膨胀
import BannerDetailPage from "./BannerDetailPage";
const AIAssistantPage = lazy(() => import("./AIAssistantPage"));
const StatementPage = lazy(() => import("./StatementPage"));
import ArticleDetailPage from "./ArticleDetailPage";
import ProductDetailPage from "./ProductDetailPage";
const VideoFeedPage = lazy(() => import("./VideoFeedPage"));

/** Layout 主内容区为 overflow-y-auto；向上找到第一个纵向可滚祖先以保存/恢复 scrollTop */
function getVerticalScrollParent(el: HTMLElement | null): HTMLElement | null {
  let p: HTMLElement | null = el?.parentElement ?? null;
  while (p) {
    const { overflowY } = window.getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

export function HomePage() {
  // 性能监控
  usePerformanceMonitor("首页");
  const navigate = useNavigate();
  const { t, isRTL } = useLanguage();
  const { config } = useConfigContext();
  const { resolve: resolveMedia } = useCmsMediaUrl();
  const networkQuality = useNetworkQuality();
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [aiOpening, setAiOpening] = useState(false);
  const [statementOpening, setStatementOpening] = useState(false);
  const [videoOpening, setVideoOpening] = useState(false);

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const homeRootRef = useRef<HTMLDivElement>(null);
  const savedHomeScrollTop = useRef(0);
  const prevViewTypeRef = useRef<string>("home");

  // 二级界面状态管理
  const [currentView, setCurrentView] = useState<
    | { type: "home" }
    | { type: "banner"; index: number; data: any }
    | { type: "aiAssistant" }
    | { type: "statement" }
    | { type: "videoFeed"; startIndex?: number }
    | { type: "article"; data: any }
    | { type: "product"; data: any }
  >({ type: "home" });

  // 从配置读取数据
  const articles = config?.articles || [];
  const bannerImages = config?.banners || [];
  const allProducts = config?.marketPage?.products || [];

  // 搜索结果 — 模糊匹配产品和文章（扩大搜索范围：名称、描述、分类、作者、正文）
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { products: [], articles: [] };
    const keywords = q.split(/\s+/).filter(Boolean);
    const matchProducts = allProducts.filter((p: any) => 
      keywords.every(kw => 
        p.name?.toLowerCase().includes(kw) || 
        p.category?.toLowerCase().includes(kw) ||
        p.subCategory?.toLowerCase().includes(kw) ||
        p.description?.toLowerCase().includes(kw) ||
        p.price?.toLowerCase().includes(kw)
      )
    ).slice(0, 12);
    const matchArticles = articles.filter((a: any) =>
      keywords.every(kw => 
        a.title?.toLowerCase().includes(kw) ||
        a.content?.toLowerCase().includes(kw) ||
        a.author?.toLowerCase().includes(kw) ||
        a.category?.toLowerCase().includes(kw)
      )
    ).slice(0, 6);
    return { products: matchProducts, articles: matchArticles };
  }, [searchQuery, allProducts, articles]);

  const hasResults = searchResults.products.length > 0 || searchResults.articles.length > 0;
  const isSearching = searchQuery.trim().length > 0;

  // 点击搜索结果后清空搜索并关闭
  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchFocused(false);
    searchInputRef.current?.blur();
  }, []);

  // 用 startTransition 包裹懒加载视图切换，避免 React 18 同步 suspend 崩溃
  const navigateTo = useCallback((view: typeof currentView) => {
    if (view.type !== "home") {
      const sp = getVerticalScrollParent(homeRootRef.current);
      if (sp) savedHomeScrollTop.current = sp.scrollTop;
    }
    startTransition(() => setCurrentView(view));
  }, []);

  /** 无网络或 chunk 拉取失败：不跳转、无任何提示（保持首页）。未登录时跳转登录页（除非管理员开启免登录 AI）。 */
  const openAiAssistant = useCallback(async () => {
    if (aiOpening) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    const allowGuestAi = config.cloudAIConfig?.allowUnauthenticatedUse === true;
    if (!allowGuestAi && !isUserLoggedIn()) {
      navigate("/login", { state: { from: "aiAssistant" } });
      return;
    }
    setAiOpening(true);
    try {
      if (
        !allowGuestAi &&
        isUserLoggedIn() &&
        isServerAssignedId() &&
        cloudAIUsesBackend()
      ) {
        await Promise.race([
          ensureEdgeSessionReadyDetailed(),
          new Promise<void>((resolve) => setTimeout(resolve, 6000)),
        ]);
      }
      await import("./AIAssistantPage");
      navigateTo({ type: "aiAssistant" });
    } catch {
      /* silent */
    } finally {
      setAiOpening(false);
    }
  }, [aiOpening, config.cloudAIConfig?.allowUnauthenticatedUse, navigate, navigateTo]);

  const openStatement = useCallback(async () => {
    if (statementOpening) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    setStatementOpening(true);
    try {
      await import("./StatementPage");
      navigateTo({ type: "statement" });
    } catch {
      /* silent */
    } finally {
      setStatementOpening(false);
    }
  }, [navigateTo, statementOpening]);

  const openVideoFeed = useCallback(async () => {
    if (videoOpening) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    setVideoOpening(true);
    try {
      await import("./VideoFeedPage");
      navigateTo({ type: "videoFeed" });
    } catch {
      /* silent */
    } finally {
      setVideoOpening(false);
    }
  }, [navigateTo, videoOpening]);

  // 关闭二级页后恢复 Layout 外层滚动位置（home 主体曾 display:none 会导致 scrollTop 被重置）
  useLayoutEffect(() => {
    if (currentView.type !== "home") {
      prevViewTypeRef.current = currentView.type;
      return;
    }
    if (prevViewTypeRef.current === "home") return;
    const sp = getVerticalScrollParent(homeRootRef.current);
    if (sp) sp.scrollTop = savedHomeScrollTop.current;
    prevViewTypeRef.current = "home";
  }, [currentView.type]);

  // 轮播配置 — 弱网下禁用自动播放
  const sliderSettings = useMemo(() => ({
    dots: true,
    infinite: true,
    speed: 800,
    autoplay: !networkQuality.disableAutoplay,
    autoplaySpeed: 5000,
    fade: true,
    pauseOnHover: true,
  }), [networkQuality.disableAutoplay]);

  // 只预加载第一张 banner 原图 URL（其余懒加载）
  useEffect(() => {
    if (bannerImages.length === 0) return;
    const firstImg = new Image();
    firstImg.src = resolveMedia(bannerImages[0].url);
  }, [bannerImages, resolveMedia]);

  // 直播封面：配置优先，否则第一条直播缩略图，最后默认图
  const liveThumbnailUrl = useMemo(() => {
    const coverUrl = config.homeIcons?.liveCoverUrl;
    if (coverUrl) return resolveMedia(coverUrl);
    const thumb = config.liveStreams?.[0]?.thumbnail;
    if (thumb) return resolveMedia(thumb);
    return resolveMedia(
      defaultConfig.liveStreams?.[0]?.thumbnail || "https://cdn.topagro.com/demo/photo-4.jpeg",
    );
  }, [config.liveStreams, config.homeIcons?.liveCoverUrl, resolveMedia]);

  return (
    <div ref={homeRootRef} className="min-h-screen" style={{ backgroundColor: 'var(--app-bg)' }}>
      {/* 二级界面路由 */}
      {currentView.type === "banner" && (
        <BannerDetailPage
          onClose={() => setCurrentView({ type: "home" })}
          bannerIndex={currentView.index}
          bannerData={currentView.data}
        />
      )}
      {currentView.type === "aiAssistant" && (
        <Suspense fallback={<HomePageSecondaryLazySkeleton />}>
          <AIAssistantPage onClose={() => setCurrentView({ type: "home" })} />
        </Suspense>
      )}
      {currentView.type === "statement" && (
        <Suspense fallback={<HomePageSecondaryLazySkeleton />}>
          <StatementPage onClose={() => setCurrentView({ type: "home" })} />
        </Suspense>
      )}
      {currentView.type === "videoFeed" && (
        <Suspense fallback={<HomePageSecondaryLazySkeleton />}>
          <VideoFeedPage 
            onClose={() => setCurrentView({ type: "home" })}
            startIndex={currentView.startIndex}
          />
        </Suspense>
      )}
      {currentView.type === "article" && (
        <ArticleDetailPage
          onClose={() => setCurrentView({ type: "home" })}
          article={currentView.data}
        />
      )}
      {currentView.type === "product" && (
        <ProductDetailPage
          onClose={() => setCurrentView({ type: "home" })}
          product={currentView.data}
        />
      )}

      {/* 首页内容：勿在二级页时卸载 — 否则关闭后整树重挂，LazyImage 从占位重新渐入，看起来像缩略图全量重载 */}
      <div
        className={currentView.type === "home" ? undefined : "hidden"}
        aria-hidden={currentView.type !== "home"}
      >
          {/* 搜索栏 */}
          <div className="bg-emerald-600 px-3 py-1.5 sticky top-0 z-10 shadow-md">
            <div className="flex gap-2 items-center max-w-screen-xl mx-auto">
              <div className="flex-1 min-w-0 bg-white rounded-full px-3 py-1.5 flex items-center gap-2 transition-all duration-300 focus-within:ring-2 focus-within:ring-emerald-300 focus-within:shadow-lg h-10">
                <Search className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  placeholder={t.home.searchPlaceholder}
                  className="flex-1 min-w-0 outline-none placeholder:text-gray-400"
                  style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  ref={searchInputRef}
                />
                {/* 清空按钮 — P2-⑦触摸目标修复 */}
                {searchQuery && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSearchQuery("")}
                    className="flex-shrink-0 w-7 h-7 flex items-center justify-center"
                    aria-label={t.common.close}
                  >
                    <X className="w-3.5 h-3.5 text-gray-400" />
                  </button>
                )}
              </div>
              {/* 搜时显示取消按钮，否则显示扫码 */}
              {isSearching || searchFocused ? (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearSearch}
                  className="text-white text-xs flex-shrink-0 active:opacity-70 whitespace-nowrap px-1"
                >
                  {t.common.cancel || "Cancel"}
                </button>
              ) : (
                <button 
                  onClick={() => setShowQRScanner(true)}
                  className="bg-white w-10 h-10 rounded-full active:scale-95 transition-all duration-200 flex items-center justify-center flex-shrink-0 shadow-sm"
                  aria-label={t.camera?.scanQRCode || 'Scan QR'}
                >
                  <ScanLine className="w-4 h-4 text-gray-600" />
                </button>
              )}
            </div>
          </div>

          {/* 搜索结果面板 — 覆盖主内容 */}
          {isSearching && (
            <div className="px-3 pb-safe-nav max-w-screen-xl mx-auto">
              {!hasResults ? (
                <div className="text-center py-16">
                  <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-400">{t.common.noResults || "No results found"}</p>
                </div>
              ) : (
                <div className="space-y-4 pt-3">
                  {/* 商品搜索结果 */}
                  {searchResults.products.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <span className="w-1 h-4 bg-emerald-600 rounded-full"></span>
                        <h3 className="text-sm text-gray-700 font-medium">
                          {t.market?.searchProducts || "Products"} ({searchResults.products.length})
                        </h3>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {searchResults.products.map((product: any) => (
                          <button
                            key={product.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              clearSearch();
                              navigateTo({ type: "product", data: product });
                            }}
                            className="bg-white rounded-xl overflow-hidden active:scale-95 transition-transform shadow-sm text-start"
                          >
                            <LazyImage
                              src={product.image}
                              alt={product.name}
                              className="w-full aspect-square bg-gray-100 object-fill"
                            />
                            <div className="p-1.5">
                              <p className="text-[11px] text-gray-800 line-clamp-2 break-words min-h-[2em]">
                                {product.name}
                              </p>
                              <span className="text-xs text-emerald-600 font-medium">{product.price}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 文章搜索结果 */}
                  {searchResults.articles.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2 px-1">
                        <span className="w-1 h-4 bg-emerald-600 rounded-full"></span>
                        <h3 className="text-sm text-gray-700 font-medium">
                          {t.home?.news || "Articles"} ({searchResults.articles.length})
                        </h3>
                      </div>
                      <div className="bg-white rounded-xl overflow-hidden shadow-sm">
                        <div className="divide-y divide-gray-100">
                          {searchResults.articles.map((article: any) => (
                            <button
                              key={article.id}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                clearSearch();
                                navigateTo({ type: "article", data: article });
                              }}
                              className="w-full px-3 py-2.5 text-start active:bg-emerald-50 transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                {article.thumbnail && (
                                  <LazyImage
                                    src={article.thumbnail}
                                    alt={article.title}
                                    className="w-12 h-12 bg-gray-100 rounded-lg flex-shrink-0 object-fill"
                                  />
                                )}
                                <h4 className="flex-1 text-sm text-gray-800 line-clamp-2 min-w-0">
                                  {article.title}
                                </h4>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 主内容区域 - 搜索时隐藏，增加底部内边距避免被底部导航遮挡 */}
          <div className="px-3 space-y-3 max-w-screen-xl mx-auto pb-safe-nav" style={{ display: isSearching ? 'none' : undefined }}>
            {/* 轮播图 — 使用网络感知优化后图片 URL */}
            <div 
              className="mt-3 rounded-2xl overflow-hidden bg-gray-100 relative active:scale-95 transition-transform cursor-pointer aspect-[2/1] shadow-lg"
            >
              <BannerCarousel {...sliderSettings}>
                {bannerImages.map((image, index) => (
                  <div 
                    key={image.id} 
                    className="slider-item relative h-full w-full min-h-0"
                    onClick={() => {
                      navigateTo({ type: "banner", index, data: image });
                    }}
                  >
                    <CmsMediaImg
                      src={image.url}
                      alt={image.alt}
                      className="absolute inset-0 h-full w-full object-fill"
                      loading={index === 0 ? "eager" : "lazy"}
                    />
                  </div>
                ))}
              </BannerCarousel>
            </div>

            {/* AI助手和对账单 — 圆形/方形自定义图标等比居中，不拉伸裁切 */}
            <div className="grid grid-cols-2 gap-3">
              <button 
                type="button"
                onClick={() => void openAiAssistant()}
                disabled={aiOpening}
                className="bg-white rounded-2xl p-4 flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg aspect-square min-h-0 disabled:opacity-70"
              >
                <div className="flex-1 min-h-0 w-full flex items-center justify-center p-2">
                  {aiOpening ? (
                    <Loader2 className="w-10 h-10 text-emerald-600 animate-spin" />
                  ) : config.homeIcons?.aiAssistantIconUrl ? (
                    <CmsMediaImg src={config.homeIcons.aiAssistantIconUrl} alt={config.homeIcons?.aiAssistantLabel || t.home.aiAssistant} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <Bot className="w-12 h-12 sm:w-14 sm:h-14 text-emerald-600 flex-shrink-0" />
                  )}
                </div>
                <span className="text-sm text-gray-800 font-medium flex-shrink-0">{config.homeIcons?.aiAssistantLabel || t.home.aiAssistant}</span>
              </button>
              <button 
                type="button"
                onClick={() => void openStatement()}
                disabled={statementOpening}
                className="bg-white rounded-2xl p-4 flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg aspect-square min-h-0 disabled:opacity-70"
              >
                <div className="flex-1 min-h-0 w-full flex items-center justify-center p-2">
                  {statementOpening ? (
                    <Loader2 className="w-10 h-10 text-emerald-600 animate-spin" />
                  ) : config.homeIcons?.statementIconUrl ? (
                    <CmsMediaImg src={config.homeIcons.statementIconUrl} alt={config.homeIcons?.statementLabel || t.home.statement} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <Calculator className="w-12 h-12 sm:w-14 sm:h-14 text-emerald-600 flex-shrink-0" />
                  )}
                </div>
                <span className="text-sm text-gray-800 font-medium flex-shrink-0">{config.homeIcons?.statementLabel || t.home.statement}</span>
              </button>
            </div>

            {/* 直播区域 */}
            <button 
              type="button"
              onClick={() => void openVideoFeed()}
              disabled={videoOpening}
              className="w-full aspect-[2/1] rounded-2xl overflow-hidden relative active:scale-95 transition-transform shadow-lg bg-gray-100 disabled:opacity-70"
            >
              {videoOpening && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30">
                  <Loader2 className="w-10 h-10 text-white animate-spin" />
                </div>
              )}
              <img
                src={liveThumbnailUrl}
                alt={config.homeIcons?.liveTitle || config.liveStreams?.[0]?.title || t.home.agriVideos}
                className="w-full h-full object-fill"
                loading="lazy"
              />
              <div className="absolute top-2 ltr:left-2 rtl:right-2 bg-red-500 text-white px-2 py-1 rounded-full text-xs flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>
                {config.homeIcons?.liveBadge || t.home.liveNavigation}
              </div>
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-start">
                <h3 className="text-white font-medium text-sm">{config.homeIcons?.liveTitle || config.liveStreams?.[0]?.title || t.home.agriVideos}</h3>
              </div>
            </button>

            {/* 文章列表 — 缩略图改用 LazyImage 懒加载 + WebP 优化 */}
            <div className="bg-white rounded-2xl overflow-hidden shadow-lg">
              <div className="divide-y divide-gray-100">
                {articles.map((article) => (
                  <button
                    key={article.id}
                    onClick={() => navigateTo({ type: "article", data: article })}
                    className="w-full px-3 py-3 text-start active:bg-emerald-100 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="flex-1 text-gray-900 text-sm sm:text-base line-clamp-2 min-w-0">
                        {article.title}
                      </h3>
                      {article.thumbnail ? (
                        <LazyImage 
                          src={article.thumbnail}
                          alt={article.title}
                          className="w-16 h-16 sm:w-20 sm:h-20 bg-gray-100 rounded-xl flex-shrink-0 object-fill"
                        />
                      ) : (
                        <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gray-100 rounded-xl flex-shrink-0"></div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* ICP备案和公备案号 - 极简样式 */}
            {(config?.filing?.icpNumber || config?.filing?.policeNumber) && (
            <div className="bg-gray-50 rounded-lg shadow-sm">
              <div className="px-3 py-2 space-y-1">
                <p className="text-xs text-gray-500">{t.home.filingNo}</p>
                {config?.filing?.icpNumber && (
                <a 
                  href={config?.filing?.icpUrl || "https://beian.miit.gov.cn/"} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="block text-[10px] text-gray-400 active:text-emerald-600"
                >
                  {config.filing.icpNumber}
                </a>
                )}
                {config?.filing?.policeNumber && (
                <a 
                  href={config?.filing?.policeUrl || "http://www.beian.gov.cn/portal/registerSystemInfo"} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="block text-[10px] text-gray-400 active:text-emerald-600"
                >
                  {config.filing.policeNumber}
                </a>
                )}
              </div>
            </div>
            )}
          </div>
      </div>

      {/* QR二维码扫描器 — 农药溯源 */}
      {showQRScanner && (
        <QRScannerCapture
          onScan={(code) => {
            setShowQRScanner(false);
            setScanResult(code);
            // 扫描结果toast 5秒后自动消失
            setTimeout(() => setScanResult(null), 5000);
          }}
          onClose={() => setShowQRScanner(false)}
        />
      )}

      {/* 扫描结果提示 — 溯源查询结果（后端接入前展示原始数据） */}
      {scanResult && (
        <div className="fixed top-16 inset-x-3 z-[70] animate-slide-up" style={{ maxWidth: '420px', margin: '0 auto' }}>
          <div className="bg-white rounded-2xl shadow-2xl border border-emerald-200 overflow-hidden">
            <div className="bg-emerald-600 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ScanLine className="w-4 h-4 text-white" />
                <span className="text-white text-sm">{t.common.featureComingSoon || 'Traceability'}</span>
              </div>
              <button onClick={() => setScanResult(null)} className="text-white/70 active:text-white p-2" aria-label={t.common.close}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-gray-500 mb-1">{t.common.qrData || 'QR Data'}:</p>
              <p className="text-sm text-gray-800 break-all select-text">{scanResult}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 默认导出用于懒加载
export default HomePage;