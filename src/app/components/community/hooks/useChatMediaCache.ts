import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ChatMessage } from "../../../services/ChatProxyService";
import {
  fetchAndCacheMedia as localFetchAndCacheMedia,
  getMediaBlob as localGetMediaBlob,
  softPruneMedia,
} from "../../../services/chatLocalStore";

/** Blob URL session cache + IndexedDB media hydration for a chat thread. */
export function useChatMediaCache(
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
) {
  const ensureMediaCachedRef = useRef<(msg: ChatMessage) => void>(() => {});
  const sessionObjectURLsRef = useRef<Set<string>>(new Set());
  const mediaResolvedIdsRef = useRef<Set<string>>(new Set());

  const trackSessionObjectUrl = useCallback((url: string | undefined) => {
    if (!url || !url.startsWith("blob:")) return;
    sessionObjectURLsRef.current.add(url);
  }, []);

  const revokeSessionObjectUrl = useCallback((url: string | undefined) => {
    if (!url || !url.startsWith("blob:")) return;
    if (!sessionObjectURLsRef.current.has(url)) return;
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    sessionObjectURLsRef.current.delete(url);
  }, []);

  const revokeOptimisticMediaUrls = useCallback((msg: ChatMessage) => {
    if (msg.type === "voice") {
      revokeSessionObjectUrl(msg.audioUrl);
      if (msg.content?.startsWith("blob:")) revokeSessionObjectUrl(msg.content);
      return;
    }
    if (msg.type === "image" || msg.type === "video") {
      revokeSessionObjectUrl(msg.content);
    }
  }, [revokeSessionObjectUrl]);

  const ensureMediaCached = useCallback((msg: ChatMessage) => {
    if (!msg?.id) return;
    if (mediaResolvedIdsRef.current.has(msg.id)) return;
    const url = msg.type === "voice" ? (msg.audioUrl || msg.content) : msg.content;
    if (!url || typeof url !== "string") return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (msg.type !== "image" && msg.type !== "voice" && msg.type !== "video") return;

    mediaResolvedIdsRef.current.add(msg.id);
    void (async () => {
      try {
        let blob: Blob | null = await localGetMediaBlob(url);
        if (!blob) {
          blob = await localFetchAndCacheMedia(url);
        }
        if (!blob) return;
        const objURL = URL.createObjectURL(blob);
        sessionObjectURLsRef.current.add(objURL);
        setChatMessages((prev) => prev.map((m) => {
          if (m.id !== msg.id) return m;
          if (m.type === "voice") {
            return { ...m, audioUrl: objURL, content: objURL };
          }
          return { ...m, content: objURL };
        }));
      } catch { /* 失败保留原 URL；云端还在 7d 内可用 */ }
    })();
  }, [setChatMessages]);

  useEffect(() => {
    ensureMediaCachedRef.current = ensureMediaCached;
  }, [ensureMediaCached]);

  useEffect(() => {
    void softPruneMedia();
  }, []);

  return {
    trackSessionObjectUrl,
    revokeOptimisticMediaUrls,
    ensureMediaCached,
    ensureMediaCachedRef,
    sessionObjectURLsRef,
    mediaResolvedIdsRef,
  };
}
