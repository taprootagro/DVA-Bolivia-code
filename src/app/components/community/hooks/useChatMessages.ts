import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type ChatMessage } from "../../../services/ChatProxyService";
import { chatUserService } from "../../../services/ChatUserService";
import { makePeerKey } from "../../../services/storeChatDirectory";
import { getOutboxForChannel } from "../../../services/chatLocalStore";
import { useChatMediaCache } from "./useChatMediaCache";
import { useChatSend } from "./useChatSend";
import { useChatPagination } from "./useChatPagination";
import { useChatChannelLifecycle } from "./useChatChannelLifecycle";
import { recallThread, rememberThread } from "../../../services/chatUiMemory";
import { useLanguage } from "../../../hooks/useLanguage";

export interface ChatActivePeerInput {
  peerKey: string;
  channelId: string;
  imUserId: string;
  imProvider?: string;
  name?: string;
  avatar?: string;
  subtitle?: string;
  phone?: string;
  storeId?: string;
}

export interface UseChatMessagesOptions {
  /** 门店线程：覆盖 config.chatContact */
  activePeer?: ChatActivePeerInput | null;
  /** 已屏蔽：仍拉历史；过滤对方新消息；禁止发送；不标记已读（可选） */
  peerBlocked?: boolean;
  /** 门店目录用户命名空间 */
  directoryUserId?: string;
  /** 收发成功后更新最近列表（门店模式） */
  onDirectoryActivity?: (args: { preview: string; incoming: boolean }) => void;
  /** 恢复前台后 getMessagesSince 补拉到的对端消息（农户未读重算） */
  onResumeCatchUp?: (missedIncoming: ChatMessage[]) => void;
}

export function useChatMessages(config: any, opts?: UseChatMessagesOptions) {
  const currentUserId = chatUserService.getUserId();
  const activePeer = opts?.activePeer;
  const peerBlocked = opts?.peerBlocked ?? false;
  const onDirectoryActivity = opts?.onDirectoryActivity;
  const onDirectoryActivityRef = useRef(onDirectoryActivity);
  onDirectoryActivityRef.current = onDirectoryActivity;
  const onResumeCatchUp = opts?.onResumeCatchUp;
  const onResumeCatchUpRef = useRef(onResumeCatchUp);
  onResumeCatchUpRef.current = onResumeCatchUp;
  const { t } = useLanguage();
  const communityTRef = useRef(t.community);
  communityTRef.current = t.community;

  const targetImUserId = activePeer?.imUserId?.trim()
    || config?.chatContact?.merchantUserId
    || "";
  const targetId = targetImUserId;

  const channelId = useMemo(() => {
    const raw = activePeer?.channelId?.trim()
      || config?.chatContact?.channelId?.trim()
      || "";
    return raw;
  }, [activePeer?.channelId, config?.chatContact?.channelId]);

  const derivedPeerKey = useMemo(
    () => activePeer?.peerKey || makePeerKey(channelId, targetImUserId),
    [activePeer?.peerKey, channelId, targetImUserId],
  );

  const [proxyMode, setProxyMode] = useState<"backend" | "mock">("mock");
  const [providerName, setProviderName] = useState("");
  const [realtimeError, setRealtimeError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
    () => (channelId ? recallThread(channelId) ?? [] : []),
  );
  /** Virtuoso prepend anchor — decremented on prepend, incremented when the
   *  memory cap trims items off the FRONT (keeps data[0] ↔ firstItemIndex). */
  const [firstItemIndex, setFirstItemIndex] = useState(10_000);
  // 本次提交里 capMessages 从头部裁掉的条数；提交后由 layout effect 同步到 firstItemIndex。
  const pendingFrontTrimRef = useRef(0);
  useLayoutEffect(() => {
    if (pendingFrontTrimRef.current > 0) {
      const trimmed = pendingFrontTrimRef.current;
      pendingFrontTrimRef.current = 0;
      setFirstItemIndex((v) => v + trimmed);
    }
  });

  const [isSending, setIsSending] = useState(false);

  const {
    trackSessionObjectUrl,
    revokeOptimisticMediaUrls,
    ensureMediaCached,
    ensureMediaCachedRef,
    sessionObjectURLsRef,
    mediaResolvedIdsRef,
  } = useChatMediaCache(setChatMessages);

  // 跨 effect/回调共享的最新状态 —— 避免 visibilitychange 闭包拿到陈旧 chatMessages
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const {
    sendTextMessage,
    sendVoiceMessage,
    sendImageMessage,
    retryFailedMessage,
  } = useChatSend({
    channelId,
    targetId,
    currentUserId: currentUserId || "",
    peerBlocked,
    setChatMessages,
    setIsSending,
    setRealtimeError,
    revokeOptimisticMediaUrls,
    ensureMediaCachedRef,
    trackSessionObjectUrl,
    onDirectoryActivityRef,
    communityTRef,
    chatMessagesRef,
  });
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
    if (channelId && channelId !== "your-channel-id" && chatMessages.length > 0) {
      rememberThread(channelId, chatMessages);
    }
  }, [chatMessages, channelId]);

  // 已见最新服务端消息 ts（ms）。初次 hist 载入后设为历史最大值；每条新消息更新。
  // 切后台（hidden）时释放 WebSocket；回前台（visible）时用该值 since 增量补拉。
  const lastSeenTsRef = useRef(0);

  const channelIdRef = useRef<string>("");
  const peerBlockedRef = useRef<boolean>(false);
  useEffect(() => {
    channelIdRef.current = channelId;
    peerBlockedRef.current = peerBlocked;
  }, [channelId, peerBlocked]);

  const {
    loadOlder,
    hasMoreOlder,
    setHasMoreOlder,
    hasMoreOlderRef,
    capMessages,
    pageSize: PAGE_SIZE,
  } = useChatPagination({
    currentUserId,
    setChatMessages,
    setFirstItemIndex,
    pendingFrontTrimRef,
    chatMessagesRef,
    channelIdRef,
    peerBlockedRef,
    ensureMediaCached,
  });

  const resumeFnRef = useRef<(() => Promise<void>) | null>(null);
  const markActivityRef = useRef<() => void>(() => {});

  useChatChannelLifecycle({
    currentUserId,
    channelId,
    targetImUserId,
    peerBlocked,
    pageSize: PAGE_SIZE,
    capMessages,
    ensureMediaCached,
    setChatMessages,
    setFirstItemIndex,
    setProxyMode,
    setProviderName,
    setRealtimeError,
    setHasMoreOlder,
    pendingFrontTrimRef,
    lastSeenTsRef,
    hasMoreOlderRef,
    chatMessagesRef,
    sessionObjectURLsRef,
    mediaResolvedIdsRef,
    resumeFnRef,
    markActivityRef,
    communityTRef,
    onDirectoryActivityRef,
    onResumeCatchUpRef,
  });

  useEffect(() => {
    if (!channelId || peerBlocked) return;
    const flushOutbox = () => {
      const me = currentUserId != null ? String(currentUserId) : "";
      const pending = chatMessagesRef.current.filter(
        (m) =>
          (m.status === "failed" || m.status === "sending") &&
          m.senderId === me,
      );
      for (const p of pending) {
        void retryFailedMessage(p.id);
      }
    };
    window.addEventListener("online", flushOutbox);
    void (async () => {
      const outbox = await getOutboxForChannel(channelId);
      if (!outbox.length) return;
      setChatMessages((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]));
        for (const m of outbox) byId.set(m.id, m);
        return capMessages([...byId.values()].sort((a, b) => a.timestamp - b.timestamp));
      });
      flushOutbox();
    })();
    return () => window.removeEventListener("online", flushOutbox);
  }, [channelId, peerBlocked, currentUserId, retryFailedMessage]);

  return {
    chatMessages,
    firstItemIndex,
    proxyMode,
    providerName,
    realtimeError,
    currentUserId,
    isSending,
    sendTextMessage,
    sendVoiceMessage,
    sendImageMessage,
    retryFailedMessage,
    /** 门店：当前会话的稳定键 */
    activePeerKey: derivedPeerKey,
    activeChannelId: channelId,
    /** D8: 上滑加载更早历史 —— 接到 Virtuoso startReached */
    loadOlder,
    /** D8: 是否还有更早的历史可拉；false 时 startReached 应短路 */
    hasMoreOlder,
  };
}
