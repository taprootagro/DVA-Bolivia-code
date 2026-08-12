import { useMemo } from "react";
import { SecondaryView } from "./SecondaryView";
import { useConfigContext } from "../hooks/ConfigProvider";
import type { ArticleConfig } from "../hooks/useHomeConfig";
import { DetailHeroVideo } from "./DetailHeroVideo";
import { CmsMediaImg } from "./CmsMediaImg";
import { sanitizeRichHtmlWithMedia } from "../utils/sanitizeRichHtml";

interface ArticleDetailPageProps {
  onClose: () => void;
  article: ArticleConfig;
}

export function ArticleDetailPage({ onClose, article }: ArticleDetailPageProps) {
  // 从配置中读取最新的文章数据，确保编辑后能实时显示
  const { config } = useConfigContext();
  const latestArticle = config.articles.find(a => a.id === article.id) || article;
  const videoUrl = latestArticle.videoUrl?.trim() || "";
  const thumb = latestArticle.thumbnail;
  const mediaConfig = useMemo(
    () => ({
      mediaCdnBaseUrl: config.backendProxyConfig?.mediaCdnBaseUrl,
      supabaseUrl: config.backendProxyConfig?.supabaseUrl,
    }),
    [config.backendProxyConfig?.mediaCdnBaseUrl, config.backendProxyConfig?.supabaseUrl],
  );
  const safeContent = useMemo(
    () => (latestArticle.content ? sanitizeRichHtmlWithMedia(latestArticle.content, mediaConfig) : ""),
    [latestArticle.content, mediaConfig],
  );

  return (
    <SecondaryView 
      onClose={onClose} 
      title=""
      showTitle={false}
    >
      <div className="p-4">
        {/* 缩略图 / 详情视频（列表仍只用缩略图） */}
        {(thumb || videoUrl) && (
          <div className="relative w-full h-48 rounded-xl overflow-hidden mb-4 bg-gray-100">
            {videoUrl ? (
              <DetailHeroVideo
                videoUrl={videoUrl}
                posterUrl={thumb}
                alt={latestArticle.title}
                className="absolute inset-0 h-full w-full"
              />
            ) : thumb ? (
              <CmsMediaImg
                src={thumb}
                alt={latestArticle.title}
                className="w-full h-full object-fill"
              />
            ) : null}
          </div>
        )}

        {/* 标题 */}
        <h2 className="text-lg text-gray-900 mb-4">{latestArticle.title}</h2>

        {/* 文章正文内容 */}
        {latestArticle.content ? (
          <div
            className="text-gray-800 text-sm leading-relaxed rich-content"
            dangerouslySetInnerHTML={{ __html: safeContent }}
          />
        ) : (
          <div className="text-gray-400 text-sm text-center py-8">
            暂无文章内容
          </div>
        )}
      </div>
    </SecondaryView>
  );
}

export default ArticleDetailPage;