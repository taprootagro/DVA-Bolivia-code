import { useCallback } from "react";
import { useHomeConfig } from "./useHomeConfig";
import { resolveMediaUrl, type MediaUrlResolveConfig } from "../utils/resolveMediaUrl";

export function useCmsMediaUrl() {
  const { config } = useHomeConfig();
  const mediaConfig: MediaUrlResolveConfig = {
    mediaCdnBaseUrl: config?.backendProxyConfig?.mediaCdnBaseUrl,
    supabaseUrl: config?.backendProxyConfig?.supabaseUrl,
  };

  const resolve = useCallback(
    (value: string | null | undefined) => resolveMediaUrl(value, mediaConfig),
    [mediaConfig.mediaCdnBaseUrl, mediaConfig.supabaseUrl],
  );

  return { resolve, mediaConfig };
}
