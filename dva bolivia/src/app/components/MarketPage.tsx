import { Search, ScanLine, X } from "lucide-react";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Virtuoso } from "react-virtuoso";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import { MarketAdDetailPage } from "./MarketAdDetailPage";
import { ProductDetailPage } from "./ProductDetailPage";
import { LazyImage } from "./LazyImage";
import type { MarketAdvertisementConfig } from "../hooks/useHomeConfig";
import { QRScannerCapture } from "./QRScannerCapture";

// ── 虚拟化行数据类型 ──
// 将二级类别标题和产品对（每行2个）扁平化为统一的行模型，
// 由 Virtuoso 进行虚拟化渲染，视口外的 DOM 节点不会被创建。
type VirtualRow =
  | { kind: 'header'; subCat: string }
  | { kind: 'product-row'; left: any; right: any | null };

export function MarketPage() {
  const { t } = useLanguage();
  const { config } = useConfigContext();
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  
  // 搜索状态
  const [marketSearchQuery, setMarketSearchQuery] = useState("");
  const [marketSearchFocused, setMarketSearchFocused] = useState(false);
  const marketSearchRef = useRef<HTMLInputElement>(null);
  // productScrollRef 已被 Virtuoso 接管，不再需要
  // const productScrollRef = useRef<HTMLDivElement>(null);

  // 二级界面状态管理
  type ViewType = 
    | { type: "market" }
    | { type: "ad"; data: MarketAdvertisementConfig }
    | { type: "product"; data: any };
  
  const [currentView, setCurrentView] = useState<ViewType>({ type: "market" });
  
  // 从配置读取类别和产品
  const categories = config.marketPage.categories || [];
  const products = config.marketPage.products || [];
  const advertisements = config.marketPage.advertisements || [];
  
  // 广告轮播
  const [adIndex, setAdIndex] = useState(0);
  const adTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (advertisements.length <= 1) return;
    if (document.hidden) return;

    adTimerRef.current = setInterval(() => {
      setAdIndex(prev => (prev + 1) % advertisements.length);
    }, 4000);

    const handleVisibility = () => {
      if (document.hidden) {
        if (adTimerRef.current) { clearInterval(adTimerRef.current); adTimerRef.current = null; }
      } else {
        adTimerRef.current = setInterval(() => {
          setAdIndex(prev => (prev + 1) % advertisements.length);
        }, 4000);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (adTimerRef.current) clearInterval(adTimerRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [advertisements.length]);
  
  // 初始选中第一个一级类别
  const [selectedCategory, setSelectedCategory] = useState(
    categories.length > 0 ? categories[0].id : ""
  );

  // 当配置中的类别变化时，确保 selectedCategory 仍然有效
  useEffect(() => {
    if (categories.length > 0 && !categories.find(cat => cat.id === selectedCategory)) {
      setSelectedCategory(categories[0].id);
    }
  }, [categories, selectedCategory]);
  
  // 获取当前选中类别的子类别列表
  const currentSubCategories = useMemo(() => {
    const category = categories.find(cat => cat.id === selectedCategory);
    return category?.subCategories || [];
  }, [categories, selectedCategory]);

  // 根据一级类别过滤产品，并按二级类别分组
  const groupedProducts = useMemo(() => {
    const filtered = products.filter(product => product.category === selectedCategory);
    
    // 按二级类别分组
    const groups: { [key: string]: any[] } = {};
    currentSubCategories.forEach(subCat => {
      groups[subCat] = filtered.filter(product => product.subCategory === subCat);
    });
    
    return groups;
  }, [products, selectedCategory, currentSubCategories]);

  // 商城搜索结果 — 跨所有类别搜索（扩大范围：名称、描述、分类、价格）
  const marketIsSearching = marketSearchQuery.trim().length > 0;
  const marketSearchResults = useMemo(() => {
    const q = marketSearchQuery.trim().toLowerCase();
    if (!q) return [];
    const keywords = q.split(/\s+/).filter(Boolean);
    return products.filter((p: any) =>
      keywords.every(kw =>
        p.name?.toLowerCase().includes(kw) ||
        p.category?.toLowerCase().includes(kw) ||
        p.subCategory?.toLowerCase().includes(kw) ||
        p.description?.toLowerCase().includes(kw) ||
        p.price?.toLowerCase().includes(kw)
      )
    );
  }, [marketSearchQuery, products]);

  const clearMarketSearch = useCallback(() => {
    setMarketSearchQuery("");
    setMarketSearchFocused(false);
    marketSearchRef.current?.blur();
  }, []);

  // ── 将分组产品扁平化为虚拟行（非搜索模式）──
  const virtualRows: VirtualRow[] = useMemo(() => {
    const rows: VirtualRow[] = [];
    currentSubCategories.forEach((subCat) => {
      const items = groupedProducts[subCat] || [];
      if (items.length === 0) return;
      // 二级类别标题行
      rows.push({ kind: 'header', subCat });
      // 每两个产品组成一行
      for (let i = 0; i < items.length; i += 2) {
        rows.push({
          kind: 'product-row',
          left: items[i],
          right: items[i + 1] || null,
        });
      }
    });
    return rows;
  }, [currentSubCategories, groupedProducts]);

  // ── 搜索结果也扁平化为虚拟行 ──
  const searchVirtualRows: VirtualRow[] = useMemo(() => {
    if (marketSearchResults.length === 0) return [];
    const rows: VirtualRow[] = [];
    for (let i = 0; i < marketSearchResults.length; i += 2) {
      rows.push({
        kind: 'product-row',
        left: marketSearchResults[i],
        right: marketSearchResults[i + 1] || null,
      });
    }
    return rows;
  }, [marketSearchResults]);

  // ── 产品卡片渲染（抽取复用）──
  const renderProductCard = useCallback((product: any) => (
    <div
      key={product.id}
      className="bg-white rounded-xl overflow-hidden active:scale-95 transition-transform shadow-md"
      onClick={() => setCurrentView({ type: "product", data: product })}
    >
      <LazyImage
        src={product.image}
        alt={product.name}
        className="w-full aspect-square bg-gray-100 object-fill"
      />
      <div className="p-2">
        <p className="text-xs text-gray-800 font-medium line-clamp-2 break-words min-h-[2rem]">
          {product.name}
        </p>
        <div className="mt-0.5">
          <span className="text-sm font-semibold text-emerald-600">{product.price}</span>
        </div>
      </div>
    </div>
  ), []);

  // ── 虚拟行渲染函数 ──
  const renderVirtualRow = useCallback((_index: number, row: VirtualRow) => {
    if (row.kind === 'header') {
      return (
        <div className="px-3 pt-4 pb-2">
          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <span className="w-1 h-4 bg-emerald-600 rounded-full"></span>
            {row.subCat}
          </h3>
        </div>
      );
    }
    // product-row: 2列网格
    return (
      <div className="px-3 pb-3">
        <div className="grid grid-cols-2 gap-3">
          {renderProductCard(row.left)}
          {row.right && renderProductCard(row.right)}
        </div>
      </div>
    );
  }, [renderProductCard]);

  // ── 广告轮播 Header 组件（置于 Virtuoso 列表顶部，随列表滚动）──
  const AdCarouselHeader = useCallback(() => {
    if (advertisements.length === 0 || marketIsSearching) return null;
    return (
      <div className="mx-3 mt-3 mb-1">
        <div
          className="relative overflow-hidden rounded-lg cursor-pointer active:scale-95 transition-transform"
          onClick={() => setCurrentView({ type: "ad", data: advertisements[adIndex] })}
        >
          <LazyImage
            src={advertisements[adIndex]?.image || ""}
            alt={advertisements[adIndex]?.title || "Ad"}
            className="w-full aspect-[3/1] bg-gray-100 object-fill"
          />
          {advertisements[adIndex]?.title && (
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4">
              <p className="text-white text-[10px] truncate">{advertisements[adIndex].title}</p>
            </div>
          )}
        </div>
        {advertisements.length > 1 && (
          <div className="flex justify-center gap-1 mt-1.5">
            {advertisements.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); setAdIndex(i); }}
                className={`rounded-full transition-all ${
                  i === adIndex ? "w-3 h-1.5 bg-emerald-600" : "w-1.5 h-1.5 bg-gray-300"
                }`}
              />
            ))}
          </div>
        )}
      </div>
    );
  }, [advertisements, adIndex, marketIsSearching]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 二级界面路由 */}
      {currentView.type === "ad" && (
        <MarketAdDetailPage onClose={() => setCurrentView({ type: "market" })} ad={currentView.data} />
      )}
      {currentView.type === "product" && (
        <ProductDetailPage
          onClose={() => setCurrentView({ type: "market" })}
          product={currentView.data}
        />
      )}

      {/* 商城主界面：二级页打开时保留挂载，避免 Virtuoso / LazyImage 关闭后整块重建 */}
      <div
        className={
          currentView.type === "market"
            ? "h-full flex flex-col overflow-hidden min-h-0"
            : "hidden"
        }
        aria-hidden={currentView.type !== "market"}
      >
          {/* 搜索栏 - 完全固定在顶部，不参与滚动 */}
          <div className="bg-emerald-600 px-3 py-1.5 z-10 flex-shrink-0">
            <div className="flex gap-2 items-center max-w-screen-xl mx-auto">
              <div className="flex-1 min-w-0 bg-white rounded-full px-3 py-1.5 flex items-center gap-2 h-10">
                <Search className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  placeholder={t.market.searchProducts}
                  className="flex-1 min-w-0 outline-none placeholder:text-gray-400"
                  style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}
                  value={marketSearchQuery}
                  onChange={(e) => setMarketSearchQuery(e.target.value)}
                  onFocus={() => setMarketSearchFocused(true)}
                  ref={marketSearchRef}
                />
                {marketSearchQuery && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setMarketSearchQuery("")}
                    className="flex-shrink-0 w-7 h-7 flex items-center justify-center"
                    aria-label={t.common.close}
                  >
                    <X className="w-3.5 h-3.5 text-gray-400" />
                  </button>
                )}
              </div>
              {marketIsSearching || marketSearchFocused ? (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearMarketSearch}
                  className="text-white text-xs flex-shrink-0 active:opacity-70 whitespace-nowrap px-1"
                >
                  {t.common.cancel || "Cancel"}
                </button>
              ) : (
                <button 
                  onClick={() => setShowQRScanner(true)}
                  className="bg-white w-10 h-10 rounded-full active:scale-95 transition-transform flex items-center justify-center flex-shrink-0"
                  aria-label={t.camera.scanQRCode}
                >
                  <ScanLine className="w-4 h-4 text-gray-600" />
                </button>
              )}
            </div>
          </div>

          {/* 主内容区域：左侧一级类别 + 右侧虚拟化产品列表 */}
          <div className="flex gap-0 flex-1 overflow-hidden">
            {/* 左侧一级类别栏 - 搜索时隐藏，独立滚动容器 */}
            {!marketIsSearching && (
            <div 
              className="w-20 flex-shrink-0 overflow-y-auto z-[5]"
              style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', backgroundColor: 'var(--app-bg)' }}
            >
              {categories.map((category) => (
                <button
                  key={category.id}
                  onClick={() => {
                    setSelectedCategory(category.id);
                  }}
                  className={`w-full py-3 px-2 text-center transition-all duration-200 active:scale-95 relative ${
                    selectedCategory === category.id
                      ? "bg-white text-emerald-600 font-medium shadow-md"
                      : "text-gray-600"
                  }`}
                  style={{ fontSize: 'clamp(11px, 3vw, 13px)' }}
                >
                  {/* 左侧绿色指示条 */}
                  {selectedCategory === category.id && (
                    <div className="absolute start-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-emerald-600 ltr:rounded-r-full rtl:rounded-l-full"></div>
                  )}
                  <div className="break-words leading-tight line-clamp-2">{category.name}</div>
                </button>
              ))}
            </div>
            )}

            {/* 右侧产品区域 — Virtuoso 虚拟化列表 */}
            <div 
              className="flex-1 min-w-0 bg-white"
              style={{ WebkitOverflowScrolling: 'touch' }}
            >
              {marketIsSearching ? (
                // ── 搜索模式 ──
                marketSearchResults.length > 0 ? (
                  <Virtuoso
                    data={searchVirtualRows}
                    overscan={400}
                    computeItemKey={(index, row) =>
                      row.kind === 'header' ? `sh-${row.subCat}` : `sr-${row.left.id}`
                    }
                    components={{
                      Header: () => (
                        <div className="px-3 pt-2 pb-1">
                          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                            <span className="w-1 h-4 bg-emerald-600 rounded-full"></span>
                            {t.common.search || "Search"} ({marketSearchResults.length})
                          </h3>
                        </div>
                      ),
                      Footer: () => <div className="h-4" />,
                    }}
                    itemContent={renderVirtualRow}
                    style={{ height: '100%' }}
                  />
                ) : (
                  <div className="text-center py-12">
                    <Search className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm text-gray-400">{t.common.noResults || "No results found"}</p>
                  </div>
                )
              ) : (
                // ── 分类浏览模式（虚拟化）──
                <Virtuoso
                  key={selectedCategory}
                  data={virtualRows}
                  overscan={400}
                  computeItemKey={(index, row) =>
                    row.kind === 'header' ? `h-${row.subCat}` : `p-${row.left.id}`
                  }
                  components={{
                    Header: AdCarouselHeader,
                    Footer: () => <div className="h-4" />,
                  }}
                  itemContent={renderVirtualRow}
                  style={{ height: '100%' }}
                />
              )}
            </div>
          </div>
      </div>

      {/* QR二维码扫描器 — 农药溯源 */}
      {showQRScanner && (
        <QRScannerCapture
          onScan={(code) => {
            setShowQRScanner(false);
            setScanResult(code);
            setTimeout(() => setScanResult(null), 5000);
          }}
          onClose={() => setShowQRScanner(false)}
        />
      )}

      {/* 扫描结果提示 */}
      {scanResult && (
        <div className="fixed top-16 inset-x-3 z-[70] animate-slide-up" style={{ maxWidth: '420px', margin: '0 auto' }}>
          <div className="bg-white rounded-2xl shadow-2xl border border-emerald-200 overflow-hidden">
            <div className="bg-emerald-600 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ScanLine className="w-4 h-4 text-white" />
                <span className="text-white text-sm">{t.common.featureComingSoon || 'Traceability'}</span>
              </div>
              <button onClick={() => setScanResult(null)} className="text-white/70 active:text-white w-10 h-10 flex items-center justify-center" aria-label={t.common.close}>
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
export default MarketPage;