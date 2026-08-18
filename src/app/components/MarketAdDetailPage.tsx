import { useMemo } from "react";
import { SecondaryView } from "./SecondaryView";
import { Megaphone } from "lucide-react";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useLanguage } from "../hooks/useLanguage";
import type { MarketAdvertisementConfig } from "../hooks/useHomeConfig";
import { CmsMediaImg } from "./CmsMediaImg";
import { sanitizeRichHtmlWithMedia } from "../utils/sanitizeRichHtml";

interface MarketAdDetailPageProps {
  onClose: () => void;
  ad: MarketAdvertisementConfig;
}

export function MarketAdDetailPage({ onClose, ad }: MarketAdDetailPageProps) {
  // 从配置中读取最新数据，确保编辑后实时显示
  const { config } = useConfigContext();
  const { t } = useLanguage();
  const latestAd = config.marketPage.advertisements.find(a => a.id === ad.id) || ad;
  const mediaConfig = useMemo(
    () => ({
      mediaCdnBaseUrl: config.backendProxyConfig?.mediaCdnBaseUrl,
      supabaseUrl: config.backendProxyConfig?.supabaseUrl,
    }),
    [config.backendProxyConfig?.mediaCdnBaseUrl, config.backendProxyConfig?.supabaseUrl],
  );
  const safeAdHtml = useMemo(
    () => (latestAd.content ? sanitizeRichHtmlWithMedia(latestAd.content, mediaConfig) : ""),
    [latestAd.content, mediaConfig],
  );

  return (
    <SecondaryView 
      onClose={onClose} 
      title={latestAd.title || t.market?.viewDetails || "Details"}
      showTitle={true}
    >
      <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--app-bg)' }}>
        {/* 大图 */}
        {latestAd.image && (
          <div className="w-full bg-gray-100">
            <CmsMediaImg 
              src={latestAd.image} 
              alt={latestAd.title} 
              className="w-full aspect-[2/1] object-fill"
            />
          </div>
        )}

        {/* 内容区 */}
        <div className="px-4 py-4">
          {latestAd.content ? (
            <div className="text-gray-700 text-sm leading-relaxed rich-content" dangerouslySetInnerHTML={{ __html: safeAdHtml }} />
          ) : (
            <div className="py-12 text-center">
              <Megaphone className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-400 text-sm">暂无详细内容</p>
              <p className="text-gray-300 text-xs mt-1">可在内容管理 → 市场广告中编辑</p>
            </div>
          )}
        </div>
      </div>
    </SecondaryView>
  );
}