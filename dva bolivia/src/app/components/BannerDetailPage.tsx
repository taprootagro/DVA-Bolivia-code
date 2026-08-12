import { useMemo } from "react";
import { SecondaryView } from "./SecondaryView";
import { FileText } from "lucide-react";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useLanguage } from "../hooks/useLanguage";
import type { BannerConfig } from "../hooks/useHomeConfig";
import { DetailHeroVideo } from "./DetailHeroVideo";
import { CmsMediaImg } from "./CmsMediaImg";
import { sanitizeRichHtmlWithMedia } from "../utils/sanitizeRichHtml";

interface BannerDetailPageProps {
  onClose: () => void;
  bannerIndex: number;
  bannerData?: BannerConfig;
}

export function BannerDetailPage({ onClose, bannerIndex, bannerData }: BannerDetailPageProps) {
  const { config } = useConfigContext();
  const { t } = useLanguage();
  const latestBanner = bannerData?.id 
    ? config.banners.find(b => b.id === bannerData.id) || bannerData 
    : bannerData;

  const title = latestBanner?.title || `${t.market.viewDetails} ${bannerIndex + 1}`;
  const videoUrl = latestBanner?.videoUrl?.trim() || "";
  const heroImage = latestBanner?.url;
  const mediaConfig = useMemo(
    () => ({
      mediaCdnBaseUrl: config.backendProxyConfig?.mediaCdnBaseUrl,
      supabaseUrl: config.backendProxyConfig?.supabaseUrl,
    }),
    [config.backendProxyConfig?.mediaCdnBaseUrl, config.backendProxyConfig?.supabaseUrl],
  );
  const safeBannerHtml = useMemo(
    () => (latestBanner?.content ? sanitizeRichHtmlWithMedia(latestBanner.content, mediaConfig) : ""),
    [latestBanner?.content, mediaConfig],
  );

  return (
    <SecondaryView 
      onClose={onClose} 
      title={title}
      showTitle={true}
    >
      <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--app-bg)' }}>
        {/* 顶部：有 videoUrl 时播视频（poster 用轮播图），否则仅大图 */}
        {(heroImage || videoUrl) && (
          <div className="px-4 pt-4">
            <div className="relative aspect-[2/1] w-full overflow-hidden rounded-2xl bg-gray-100 shadow">
              {videoUrl ? (
                <DetailHeroVideo
                  videoUrl={videoUrl}
                  posterUrl={heroImage}
                  alt={latestBanner?.alt || title}
                />
              ) : heroImage ? (
                <CmsMediaImg
                  src={heroImage}
                  alt={latestBanner?.alt || title}
                  className="absolute inset-0 h-full w-full object-fill"
                />
              ) : null}
            </div>
          </div>
        )}

        {/* 内容区 */}
        <div className="px-4 py-4 space-y-3">
          {/* 标题卡片 */}
          <div className="bg-white rounded-2xl p-4 shadow">
            <h2 className="text-gray-800 text-lg">
              {title}
            </h2>
            {latestBanner?.alt && (
              <p className="text-gray-500 text-xs mt-1">{latestBanner.alt}</p>
            )}
          </div>

          {/* 详细内容 */}
          {latestBanner?.content && (
            <div className="bg-white rounded-2xl p-4 shadow">
              <div className="text-gray-700 text-sm rich-content" dangerouslySetInnerHTML={{ __html: safeBannerHtml }} />
            </div>
          )}

          {/* 无内容提示 */}
          {!latestBanner?.content && (
            <div className="bg-white rounded-2xl p-6 shadow text-center">
              <FileText className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-400 text-sm">{t.common.loading}</p>
            </div>
          )}
        </div>
      </div>
    </SecondaryView>
  );
}

export default BannerDetailPage;