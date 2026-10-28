import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { chatService, type ChatMessage } from "../../../services/ChatProxyService";
import { cacheMessages as localCacheMessages, getOlder as localGetOlder } from "../../../services/chatLocalStore";

export const CHAT_PAGE_SIZE = 30;
export const CHAT_MEMORY_CAP = 200;
export const CHAT_MEMORY_TRIM = 50;

type UseChatPaginationArgs = {
  currentUserId: string | null | undefined;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setFirstItemIndex: Dispatch<SetStateAction<number>>;
  pendingFrontTrimRef: MutableRefObject<number>;
  chatMessagesRef: MutableRefObject<ChatMessage[]>;
  channelIdRef: MutableRefObject<string>;
  peerBlockedRef: MutableRefObject<boolean>;
  ensureMediaCached: (msg: ChatMessage) => void;
};

/** Virtuoso prepend + memory cap for a chat thread. */
export function useChatPagination({
  currentUserId,
  setChatMessages,
  setFirstItemIndex,
  pendingFrontTrimRef,
  chatMessagesRef,
  channelIdRef,
  peerBlockedRef,
  ensureMediaCached,
}: UseChatPaginationArgs) {
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const isLoadingOlderRef = useRef(false);
  const hasMoreOlderRef = useRef(false);

  const capMessages = useCallback((list: ChatMessage[]): ChatMessage[] => {
    if (list.length <= CHAT_MEMORY_CAP) return list;
    const trimmed = list.length - (CHAT_MEMORY_CAP - CHAT_MEMORY_TRIM);
    pendingFrontTrimRef.current = trimmed;
    return list.slice(trimmed);
  }, [pendingFrontTrimRef]);

  const loadOlder = useCallback(async () => {
    if (isLoadingOlderRef.current) return;
    if (!hasMoreOlderRef.current) return;
    const ch = channelIdRef.current;
    if (!ch) return;
    const head = chatMessagesRef.current[0];
    if (!head) return;

    isLoadingOlderRef.current = true;
    try {
      const seenInMem = new Set(chatMessagesRef.current.map((m) => m.id));
      let collected: ChatMessage[] = [];

      try {
        const local = await localGetOlder(ch, head.timestamp, CHAT_PAGE_SIZE);
        collected = local.filter((m) => !seenInMem.has(m.id));
      } catch (e) {
        console.warn("[Community] loadOlder local failed", e);
      }

      if (collected.length < CHAT_PAGE_SIZE) {
        try {
          const beforeIso = new Date(head.timestamp).toISOString();
          const remote = await chatService.getMessagesBefore(ch, beforeIso, CHAT_PAGE_SIZE);
          if (remote.length > 0) {
            void localCacheMessages(remote);
            const localIds = new Set(collected.map((m) => m.id));
            for (const m of remote) {
              if (!seenInMem.has(m.id) && !localIds.has(m.id)) collected.push(m);
            }
            collected.sort((a, b) => a.timestamp - b.timestamp);
            if (collected.length > CHAT_PAGE_SIZE) {
              collected = collected.slice(collected.length - CHAT_PAGE_SIZE);
            }
          }
        } catch (e) {
          console.warn("[Community] loadOlder remote failed", e);
        }
      }

      const filtered = collected.filter((m) => {
        if (peerBlockedRef.current) {
          const sid = m.senderId != null ? String(m.senderId) : "";
          const me = currentUserId != null ? String(currentUserId) : "";
          if (sid !== "" && sid !== me) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        hasMoreOlderRef.current = false;
        setHasMoreOlder(false);
        return;
      }

      setChatMessages((prev) => [...filtered, ...prev]);
      setFirstItemIndex((prev) => prev - filtered.length);
      if (!peerBlockedRef.current) {
        chatService.markSeen(filtered.map((m) => m.id));
      }
      for (const m of filtered) ensureMediaCached(m);

      const more = filtered.length >= CHAT_PAGE_SIZE;
      hasMoreOlderRef.current = more;
      setHasMoreOlder(more);
    } catch (e) {
      console.warn("[Community] loadOlder failed", e);
    } finally {
      isLoadingOlderRef.current = false;
    }
  }, [channelIdRef, chatMessagesRef, currentUserId, ensureMediaCached, peerBlockedRef, setChatMessages, setFirstItemIndex]);

  return {
    loadOlder,
    hasMoreOlder,
    setHasMoreOlder,
    hasMoreOlderRef,
    capMessages,
    pageSize: CHAT_PAGE_SIZE,
  };
}
