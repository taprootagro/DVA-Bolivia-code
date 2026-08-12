import { useMemo } from "react";
import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import { sanitizeRichHtmlWithMedia } from "../utils/sanitizeRichHtml";

interface AboutUsPageProps {
  onClose: () => void;
}

export function AboutUsPage({ onClose }: AboutUsPageProps) {
  const { t } = useLanguage();
  const { config } = useConfigContext();

  const mediaConfig = useMemo(
    () => ({
      mediaCdnBaseUrl: config?.backendProxyConfig?.mediaCdnBaseUrl,
      supabaseUrl: config?.backendProxyConfig?.supabaseUrl,
    }),
    [config?.backendProxyConfig?.mediaCdnBaseUrl, config?.backendProxyConfig?.supabaseUrl],
  );

  const safeHtml = useMemo(
    () =>
      sanitizeRichHtmlWithMedia(
        config?.aboutUs?.content || t.common.noContent || "No content yet",
        mediaConfig,
      ),
    [config?.aboutUs?.content, t.common.noContent, mediaConfig],
  );

  return (
    <SecondaryView 
      onClose={onClose} 
      title={t.profile.aboutUs}
      showTitle={true}
    >
      <div className="p-4">
        <div className="bg-white rounded-2xl p-5 shadow-sm">
          <div className="text-sm text-gray-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: safeHtml }} />
        </div>
      </div>
    </SecondaryView>
  );
}