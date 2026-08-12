import { useMemo } from "react";
import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import type { MarketProductConfig } from "../hooks/useHomeConfig";
import { DetailHeroVideo } from "./DetailHeroVideo";
import { CmsMediaImg } from "./CmsMediaImg";
import { sanitizeRichHtmlWithMedia } from "../utils/sanitizeRichHtml";

interface ProductDetailPageProps {
  onClose: () => void;
  product: MarketProductConfig;
}

export function ProductDetailPage({ onClose, product }: ProductDetailPageProps) {
  const { t } = useLanguage();
  const { config } = useConfigContext();
  const m = t.market;

  const latest = useMemo(
    () => config.marketPage.products.find((p) => p.id === product.id) || product,
    [config.marketPage.products, product]
  );

  const mediaConfig = useMemo(
    () => ({
      mediaCdnBaseUrl: config.backendProxyConfig?.mediaCdnBaseUrl,
      supabaseUrl: config.backendProxyConfig?.supabaseUrl,
    }),
    [config.backendProxyConfig?.mediaCdnBaseUrl, config.backendProxyConfig?.supabaseUrl],
  );

  const safeDetails = useMemo(
    () => (latest.details ? sanitizeRichHtmlWithMedia(latest.details, mediaConfig) : ""),
    [latest.details, mediaConfig],
  );
  const safeSpecs = useMemo(
    () => (latest.specifications ? sanitizeRichHtmlWithMedia(latest.specifications, mediaConfig) : ""),
    [latest.specifications, mediaConfig],
  );

  const videoUrl = latest.videoUrl?.trim() || "";
  const heroImage = latest.image;

  return (
    <SecondaryView 
      onClose={onClose} 
      title={m.productDetail || 'Product Details'}
      showTitle={true}
    >
      <div className="pb-6">
        {/* 商品主图 / 可选详情视频 */}
        <div className="relative w-full aspect-square overflow-hidden bg-gray-100">
          {videoUrl ? (
            <DetailHeroVideo
              videoUrl={videoUrl}
              posterUrl={heroImage}
              alt={latest.name}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <CmsMediaImg
              src={heroImage}
              alt={latest.name}
              className="h-full w-full object-fill"
            />
          )}
        </div>
        
        {/* 商品信息区域 */}
        <div className="p-4">
          {/* 商品名称 */}
          <h2 className="text-lg font-bold text-gray-900 mb-2">{latest.name}</h2>
          
          {/* 简短描述 */}
          {latest.description && (
            <p className="text-sm text-gray-600 mb-3">{latest.description}</p>
          )}
          
          {/* 价格和库存 */}
          <div className="flex items-center justify-between mb-4 pb-4 border-b border-gray-200">
            <div>
              <p className="text-xs text-gray-500 mb-1">{m.price}</p>
              <p className="text-2xl font-bold text-emerald-600">{latest.price}</p>
            </div>
            {latest.stock !== undefined && (
              <div className="text-end">
                <p className="text-xs text-gray-500 mb-1">{m.stock || 'Stock'}</p>
                <p className="text-lg font-semibold text-gray-700">{latest.stock}</p>
              </div>
            )}
          </div>
          
          {/* 产品详细说明 */}
          {latest.details && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <span className="w-1 h-4 bg-emerald-600 rounded-full"></span>
                {m.details || 'Details'}
              </h3>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-sm text-gray-700 leading-relaxed rich-content" dangerouslySetInnerHTML={{ __html: safeDetails }} />
              </div>
            </div>
          )}
          
          {/* 产品规格 */}
          {latest.specifications && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <span className="w-1 h-4 bg-emerald-600 rounded-full"></span>
                {m.specifications || 'Specifications'}
              </h3>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-sm text-gray-700 leading-relaxed rich-content" dangerouslySetInnerHTML={{ __html: safeSpecs }} />
              </div>
            </div>
          )}

        </div>
      </div>
    </SecondaryView>
  );
}

export default ProductDetailPage;