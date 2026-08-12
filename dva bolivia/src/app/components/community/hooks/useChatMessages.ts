import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { chatService, type ChatMessage } from "../../../services/ChatProxyService";
import { chatUserService } from "../../../services/ChatUserService";
import { ensureEdgeSessionReady } from "../../../utils/auth";
import { makePeerKey } from "../../../services/storeChatDirectory";
import {
  cacheMessages as localCacheMessages,
  getRecent as localGetRecent,
  getOlder as localGetOlder,
  getLatestTimestamp as localGetLatestTs,
  fetchAndCacheMedia as localFetchAndCacheMedia,
  getMediaBlob as localGetMediaBlob,
  softPruneMedia,
} from "../../../services/chatLocalStore";
import { bridge, isNative } from "../../../utils/capacitor-bridge";

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

function previewFromMessage(msg: ChatMessage): string {
  if (msg.type === "text") return (msg.content || "").slice(0, 120);
  if (msg.type === "image") return "[Image]";
  if (msg.type === "voice") return "[Voice]";
  if (msg.type === "video") return "[Video]";
  return "";
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

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
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
  const sendInFlightRef = useRef(false);

  // 媒体本地化回调由 ref 持有（在下方定义），避免 useCallback 声明顺序耦合
  const ensureMediaCachedRef = useRef<(msg: ChatMessage) => void>(() => {});

  // 本会话创建的所有 objectURL（媒体缓存命中后 createObjectURL 产生），卸载时统一 revoke
  const sessionObjectURLsRef = useRef<Set<string>>(new Set());
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

  const sendWithOptimisticUpdate = useCallback(
    async (
      msgOverrides: Partial<ChatMessage> & { type: ChatMessage["type"] },
      serviceSend: () => Promise<ChatMessage>,
      sendOpts?: { setLoading?: boolean },
    ) => {
      if (peerBlocked) {
        if (sendOpts?.setLoading) setIsSending(false);
        return;
      }
      if (sendInFlightRef.current) return;
      sendInFlightRef.current = true;
      if (sendOpts?.setLoading) setIsSending(true);

      const optimisticMsg: ChatMessage = {
        id: `m${Date.now()}_opt`,
        channelName: "default-channel",
        senderId: currentUserId,
        content: "",
        timestamp: Date.now(),
        status: "sending",
        read: false,
        ...msgOverrides,
      };

      setChatMessages((prev) => [...prev, optimisticMsg]);

      try {
        const sentMsg = await serviceSend();
        revokeOptimisticMediaUrls(optimisticMsg);
        setChatMessages((prev) =>
          prev.map((m) => (m.id === optimisticMsg.id ? { ...sentMsg } : m)),
        );
        if (sentMsg.status === "sent") {
          void localCacheMessages([sentMsg]);
          ensureMediaCachedRef.current(sentMsg);
          if (onDirectoryActivityRef.current) {
            onDirectoryActivityRef.current({ preview: previewFromMessage(sentMsg), incoming: false });
          }
        }
      } catch (err) {
        revokeOptimisticMediaUrls(optimisticMsg);
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.startsWith("CHAT_RATE_LIMIT:")) {
          const secs = parseInt(errMsg.split(":")[1] || "0", 10);
          setRealtimeError(
            secs > 0
              ? `Sending too fast — wait ${secs}s before retrying.`
              : "Sending too fast — please wait before retrying.",
          );
        }
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticMsg.id ? { ...m, status: "failed" as const } : m,
          ),
        );
      } finally {
        sendInFlightRef.current = false;
        if (sendOpts?.setLoading) setIsSending(false);
      }
    },
    [currentUserId, peerBlocked, revokeOptimisticMediaUrls],
  );

  // 跨 effect/回调共享的最新状态 —— 避免 visibilitychange 闭包拿到陈旧 chatMessages
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  // 已见最新服务端消息 ts（ms）。初次 hist 载入后设为历史最大值；每条新消息更新。
  // 切后台（hidden）时释放 WebSocket；回前台（visible）时用该值 since 增量补拉。
  const lastSeenTsRef = useRef(0);

  // ---- D8: 历史分页 ----
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const isLoadingOlderRef = useRef(false);
  const hasMoreOlderRef = useRef(false);
  const channelIdRef = useRef<string>("");
  const targetImUserIdRef = useRef<string>("");
  const peerBlockedRef = useRef<boolean>(false);
  useEffect(() => {
    channelIdRef.current = channelId;
    targetImUserIdRef.current = targetImUserId;
    peerBlockedRef.current = peerBlocked;
  }, [channelId, targetImUserId, peerBlocked]);

  const PAGE_SIZE = 30;
  // 内存硬上限：超过 MEMORY_CAP 时切掉最旧 MEMORY_TRIM 条（老的仍在 IndexedDB，loadOlder 可回补）
  const MEMORY_CAP = 200;
  const MEMORY_TRIM = 50;

  // refs 保存最新 resumeAfterHidden / leaveActive 引用，供外部 loadOlder 等使用
  const resumeFnRef = useRef<(() => Promise<void>) | null>(null);
  const markActivityRef = useRef<() => void>(() => {});

  // 已完成媒体缓存的消息 id，避免同一条消息多次 fetch
  const mediaResolvedIdsRef = useRef<Set<string>>(new Set());

  /** 内存硬顶裁剪：prev 超过 MEMORY_CAP 时切掉最旧的 MEMORY_TRIM 条。
   *  裁掉的是头部条数，记入 pendingFrontTrimRef，提交后同步给 firstItemIndex，
   *  保证 Virtuoso 的 data[0] ↔ firstItemIndex 不漂移。 */
  const capMessages = useCallback((list: ChatMessage[]): ChatMessage[] => {
    if (list.length <= MEMORY_CAP) return list;
    const trimmed = list.length - (MEMORY_CAP - MEMORY_TRIM);
    pendingFrontTrimRef.current = trimmed;
    return list.slice(trimmed);
  }, []);

  /** 后台抓远端媒体 → 写 IndexedDB → createObjectURL → 回写消息的 content/audioUrl */
  const ensureMediaCached = useCallback((msg: ChatMessage) => {
    if (!msg?.id) return;
    if (mediaResolvedIdsRef.current.has(msg.id)) return;
    // 仅处理远端 URL（http/https），blob:/data: 已是本地
    const url = msg.type === "voice" ? (msg.audioUrl || msg.content) : msg.content;
    if (!url || typeof url !== "string") return;
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (msg.type !== "image" && msg.type !== "voice" && msg.type !== "video") return;

    mediaResolvedIdsRef.current.add(msg.id);
    void (async () => {
      try {
        // 命中：直接用缓存 blob；未命中：抓一次并落盘
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
      } catch { /* 失败保留原 URL；云端还在 24h 内可用 */ }
    })();
  }, []);
  // 发送侧通过 ref 调用 ensureMediaCached，避免 useCallback 声明顺序耦合
  useEffect(() => {
    ensureMediaCachedRef.current = ensureMediaCached;
  }, [ensureMediaCached]);

  // 启动时触发一次本地媒体缓存的 LRU 修剪（80MB 上限），避免累积过多老 blob
  useEffect(() => {
    void softPruneMedia();
  }, []);

  useEffect(() => {
    chatService.setUserId(currentUserId);
    setProxyMode(chatService.mode);
    setProviderName(chatService.providerInfo.name);
    chatService.setTargetUserId(targetImUserId);

    if (!channelId || channelId === "your-channel-id") {
      console.log("[Community] No channelId bound yet — waiting for QR scan");
      setChatMessages([]);
      pendingFrontTrimRef.current = 0;
      setFirstItemIndex(10_000);
      lastSeenTsRef.current = 0;
      hasMoreOlderRef.current = false;
      setHasMoreOlder(false);
      return;
    }

    console.log(
      `[Community] Channel: ${channelId} (me: ${currentUserId} → peer: ${targetImUserId})`,
    );

    pendingFrontTrimRef.current = 0;
    setFirstItemIndex(10_000);

    let cancelled = false;
    // 每次 resume 递增；异步任务返回时比对，避免旧 resume 覆盖新状态
    let resumeSeq = 0;

    // ---- C7 grace period + C6 idle disconnect 状态 ----
    const HIDE_GRACE_MS = 4000;
    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    const IDLE_CHECK_MS = 60 * 1000;

    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let lastActivityTs = Date.now();
    // 当前 channel 是否处于「主动释放」状态：由 grace 超时或 idle 超时触发的 leaveChannel
    let released = false;

    const clearHideTimer = () => {
      if (hideTimer != null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const applyIncrement = (missed: ChatMessage[]) => {
      if (!missed || missed.length === 0) return;
      setChatMessages((prev) => {
        if (missed.length === 0) return prev;
        const seen = new Set(prev.map((m) => m.id));
        const adds: ChatMessage[] = [];
        for (const m of missed) {
          if (seen.has(m.id)) continue;
          if (peerBlocked) {
            const sid = m.senderId != null ? String(m.senderId) : "";
            const me = currentUserId != null ? String(currentUserId) : "";
            if (sid !== "" && sid !== me) continue; // 屏蔽对方消息
          }
          adds.push(m);
        }
        if (adds.length === 0) return prev;
        const merged = [...prev, ...adds].sort((a, b) => a.timestamp - b.timestamp);
        return capMessages(merged);
      });
      // 落 IndexedDB + 预取媒体 blob（云端 24h 后会被清理）
      void localCacheMessages(missed);
      for (const m of missed) ensureMediaCached(m);
      if (!peerBlocked) {
        chatService.markSeen(missed.map((m) => m.id));
      }
      const maxTs = missed.reduce(
        (acc, x) => (x.timestamp > acc ? x.timestamp : acc),
        lastSeenTsRef.current,
      );
      if (maxTs > lastSeenTsRef.current) lastSeenTsRef.current = maxTs;
    };

    const initialJoin = async () => {
      await ensureEdgeSessionReady();

      const regResult = await chatUserService.registerOnProvider();
      if (!cancelled && regResult.success) {
        console.log(`[Community] User ${currentUserId} registered on ${chatService.provider}`);
      } else if (!cancelled) {
        console.warn(`[Community] User registration issue: ${regResult.error}`);
      }

      // ①【先本地】零延迟渲染 —— 从 IndexedDB 拉最近 30 条
      const localRecent = await localGetRecent(channelId, PAGE_SIZE);
      if (!cancelled && localRecent.length > 0) {
        const filtered = peerBlocked
          ? localRecent.filter((m) => String(m.senderId ?? "") === String(currentUserId ?? ""))
          : localRecent;
        setChatMessages(capMessages(filtered));
        const maxTs = filtered.reduce((acc, x) => (x.timestamp > acc ? x.timestamp : acc), 0);
        lastSeenTsRef.current = maxTs;
        // 允许 loadOlder 尝试拉更早历史（可能走本地也可能走服务端）
        hasMoreOlderRef.current = true;
        setHasMoreOlder(true);
        // 兜底：旧消息里如果有远端 URL，继续本地化（跨会话保活）
        for (const m of filtered) ensureMediaCached(m);
      }

      // ②【再订阅】订阅 broadcast
      try {
        await chatService.joinChannel(channelId, targetImUserId);
        if (!cancelled) {
          console.log(`[Community] Joined channel: ${channelId}`);
          setRealtimeError(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Community] joinChannel failed:`, err);
        if (!cancelled) {
          setRealtimeError(
            msg.includes("CHAT_REALTIME")
              ? "Live chat connection failed — you may not receive new messages until you reopen this chat."
              : "Could not connect to live chat — pull to refresh or reopen this conversation.",
          );
        }
      }

      // ③【服务端基线】始终拉最近一页（对方离线时发的消息只在库里，不能只靠 since 增量）
      if (cancelled) return;
      try {
        const hist = await chatService.getHistory(channelId, targetImUserId, PAGE_SIZE);
        if (!cancelled && hist.length > 0) {
          applyIncrement(hist);
          const more = hist.length >= PAGE_SIZE || localRecent.length >= PAGE_SIZE;
          hasMoreOlderRef.current = more;
          setHasMoreOlder(more);
        } else if (!cancelled && localRecent.length === 0) {
          hasMoreOlderRef.current = false;
          setHasMoreOlder(false);
        }
      } catch (err) {
        console.warn("[Community] init getHistory failed", err);
      }

      // ④【再增量】补拉基线之后的新消息（含重连期间）
      if (cancelled) return;
      const sinceTs = Math.max(
        lastSeenTsRef.current,
        await localGetLatestTs(channelId),
      );
      if (sinceTs > 0) {
        try {
          const missed = await chatService.getMessagesSince(channelId, sinceTs);
          if (cancelled) return;
          applyIncrement(missed);
        } catch (err) {
          console.warn("[Community] init getMessagesSince failed", err);
        }
      }

      chatService.startPolling();
      released = false;
    };

    const resumeAfterHidden = async () => {
      resumeSeq += 1;
      const mySeq = resumeSeq;
      const sinceBeforeResume = lastSeenTsRef.current;

      await ensureEdgeSessionReady();

      try {
        await chatService.joinChannel(channelId, targetImUserId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[Community] resume joinChannel failed", err);
        if (!cancelled && mySeq === resumeSeq) {
          setRealtimeError(
            msg.includes("CHAT_REALTIME")
              ? "Live chat connection failed — you may not receive new messages until you reopen this chat."
              : "Could not reconnect to live chat — pull to refresh or reopen this conversation.",
          );
        }
      }
      if (cancelled || mySeq !== resumeSeq) return;

      // 重新订阅前先回种 dedup 集合（leaveChannel 已清空 _seenMessageIds）
      chatService.markSeen(chatMessagesRef.current.map((m) => m.id));
      chatService.startPolling();
      released = false;
      lastActivityTs = Date.now();

      try {
        const hist = await chatService.getHistory(channelId, targetImUserId, PAGE_SIZE);
        if (cancelled || mySeq !== resumeSeq) return;
        applyIncrement(hist);
      } catch (err) {
        console.warn("[Community] resume getHistory failed", err);
      }

      const since = sinceBeforeResume;
      if (since > 0) {
        try {
          const missed = await chatService.getMessagesSince(channelId, since);
          if (cancelled || mySeq !== resumeSeq) return;
          applyIncrement(missed);
          const me = currentUserId != null ? String(currentUserId) : "";
          const incomingMissed = missed.filter((m) => {
            const sid = m.senderId != null ? String(m.senderId) : "";
            return sid !== "" && sid !== me;
          });
          if (incomingMissed.length > 0) {
            onResumeCatchUpRef.current?.(incomingMissed);
          }
        } catch (err) {
          console.warn("[Community] resume getMessagesSince failed", err);
        }
      }
    };
    resumeFnRef.current = resumeAfterHidden;

    // C7: 前后台前台标记（原生 appStateChange；Web 用 document.visibilityState）
    const appIsActiveRef = { current: true };

    // C6: 任意活动 → 刷新 lastActivity；若处于 released 状态则恢复
    const isForeground = () =>
      isNative() ? appIsActiveRef.current : document.visibilityState === "visible";

    const markActivity = () => {
      lastActivityTs = Date.now();
      if (released && isForeground()) {
        console.log("[Community] activity after idle release → resume");
        void resumeAfterHidden();
      }
    };
    markActivityRef.current = markActivity;

    void initialJoin();

    const unsubscribe = chatService.onMessage((incomingMsg) => {
      if (incomingMsg.channelName && incomingMsg.channelName !== channelId) return;
      const sid = incomingMsg.senderId != null ? String(incomingMsg.senderId) : "";
      const me = currentUserId != null ? String(currentUserId) : "";
      const incomingFromOther = sid !== "" && sid !== me;
      if (peerBlocked && incomingFromOther) return;
      if (incomingMsg.timestamp > lastSeenTsRef.current) {
        lastSeenTsRef.current = incomingMsg.timestamp;
      }
      // 收发新消息也算活跃，避免边聊边触发 idle 断开
      lastActivityTs = Date.now();
      setChatMessages((prev) => {
        if (prev.some((m) => m.id === incomingMsg.id)) return prev;
        return capMessages([...prev, incomingMsg]);
      });
      // 持久化 + 异步本地化媒体
      void localCacheMessages([incomingMsg]);
      ensureMediaCached(incomingMsg);
      const cb = onDirectoryActivityRef.current;
      if (cb && !(peerBlocked && incomingFromOther)) {
        cb({ preview: previewFromMessage(incomingMsg), incoming: incomingFromOther });
      }
    });

    // C7: 前后台切换 —— Web 用 visibilitychange；原生用 appStateChange
    let appStateCleanup: (() => void) | null = null;

    const handleBackground = () => {
      if (cancelled) return;
      clearHideTimer();
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (cancelled) return;
        console.log(
          `[Community] hidden ≥${HIDE_GRACE_MS}ms → leaveChannel (release WebSocket)`,
        );
        chatService.leaveChannel();
        released = true;
      }, HIDE_GRACE_MS);
    };

    const handleForeground = () => {
      if (cancelled) return;
      if (hideTimer != null) {
        clearHideTimer();
        console.log("[Community] visible within grace → keep WebSocket");
        lastActivityTs = Date.now();
        return;
      }
      console.log("[Community] page visible → rejoin + catch-up");
      void resumeAfterHidden();
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        handleBackground();
      } else if (document.visibilityState === "visible") {
        handleForeground();
      }
    };

    if (isNative()) {
      void bridge.app.onStateChange((state) => {
        appIsActiveRef.current = state.isActive;
        if (!state.isActive) {
          handleBackground();
        } else {
          handleForeground();
        }
      }).then((cleanup) => {
        // 快速卸载时 effect cleanup 可能已先于 Promise resolve 执行 —— 立即回收避免 listener 泄漏
        if (cancelled) {
          cleanup();
          return;
        }
        appStateCleanup = cleanup;
      });
    } else {
      document.addEventListener("visibilitychange", onVisibility);
    }

    // C6: 用户活动监听（被动，不阻 throttle 不必要）
    const activityEvents: Array<keyof DocumentEventMap> = [
      "pointerdown",
      "keydown",
      "touchstart",
      "wheel",
    ];
    const activityHandler = () => {
      if (cancelled) return;
      markActivity();
    };
    for (const ev of activityEvents) {
      document.addEventListener(ev, activityHandler, { passive: true });
    }

    // C6: 周期检查 idle —— 前台 5min 无活动则释放 WebSocket
    idleTimer = setInterval(() => {
      if (cancelled) return;
      if (!isForeground()) return;
      if (released) return;
      if (Date.now() - lastActivityTs < IDLE_TIMEOUT_MS) return;
      console.log(
        `[Community] foreground idle ≥${IDLE_TIMEOUT_MS / 1000}s → leaveChannel (release WebSocket)`,
      );
      chatService.leaveChannel();
      released = true;
    }, IDLE_CHECK_MS);

    return () => {
      cancelled = true;
      clearHideTimer();
      if (idleTimer != null) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      for (const ev of activityEvents) {
        document.removeEventListener(ev, activityHandler);
      }
      appStateCleanup?.();
      if (!isNative()) {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      unsubscribe();
      chatService.leaveChannel();
      resumeFnRef.current = null;
      markActivityRef.current = () => {};
      // 本会话期间创建的所有 blob: URL 统一回收
      for (const u of sessionObjectURLsRef.current) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      }
      sessionObjectURLsRef.current.clear();
      mediaResolvedIdsRef.current.clear();
    };
  }, [currentUserId, channelId, targetImUserId, peerBlocked, capMessages, ensureMediaCached]);

  // D8: loadOlder —— 由 Virtuoso startReached 触发；isLoadingOlderRef 互斥；hasMoreOlder 终止
  // 取数优先级：① IndexedDB 本地缓存 → ② 服务端 getMessagesBefore（云端仅 24h 保留）
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

      // ① 本地缓存优先
      try {
        const local = await localGetOlder(ch, head.timestamp, PAGE_SIZE);
        collected = local.filter((m) => !seenInMem.has(m.id));
      } catch (e) {
        console.warn("[Community] loadOlder local failed", e);
      }

      // ② 本地不足 → 补服务端（若还在 24h 内）
      if (collected.length < PAGE_SIZE) {
        try {
          const beforeIso = new Date(head.timestamp).toISOString();
          const remote = await chatService.getMessagesBefore(ch, beforeIso, PAGE_SIZE);
          if (remote.length > 0) {
            void localCacheMessages(remote);
            const localIds = new Set(collected.map((m) => m.id));
            for (const m of remote) {
              if (!seenInMem.has(m.id) && !localIds.has(m.id)) collected.push(m);
            }
            collected.sort((a, b) => a.timestamp - b.timestamp);
            // 只保留最靠近当前 head 的 PAGE_SIZE 条
            if (collected.length > PAGE_SIZE) {
              collected = collected.slice(collected.length - PAGE_SIZE);
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

      // 如果本地拿到了完整一页，还可能有更早；否则认为到底
      const more = filtered.length >= PAGE_SIZE;
      hasMoreOlderRef.current = more;
      setHasMoreOlder(more);
    } catch (e) {
      console.warn("[Community] loadOlder failed", e);
    } finally {
      isLoadingOlderRef.current = false;
    }
  }, [currentUserId, ensureMediaCached]);

  const sendTextMessage = useCallback(
    async (content: string) => {
      if (peerBlocked) return;
      await sendWithOptimisticUpdate(
        { type: "text", content },
        () => chatService.sendMessage(content, "text", undefined, targetId),
        { setLoading: true },
      );
    },
    [sendWithOptimisticUpdate, targetId, peerBlocked],
  );

  const sendVoiceMessage = useCallback(
    async (duration: number, audioBlob: Blob) => {
      if (peerBlocked) return;
      const localAudioUrl = URL.createObjectURL(audioBlob);
      trackSessionObjectUrl(localAudioUrl);
      await sendWithOptimisticUpdate(
        { type: "voice", content: localAudioUrl, duration, audioUrl: localAudioUrl },
        () => chatService.sendMessage("", "voice", duration, targetId, audioBlob),
        { setLoading: true },
      );
    },
    [sendWithOptimisticUpdate, targetId, peerBlocked, trackSessionObjectUrl],
  );

  const sendImageMessage = useCallback(
    async (imageData: string) => {
      if (peerBlocked) return;
      trackSessionObjectUrl(imageData);
      await sendWithOptimisticUpdate(
        { type: "image", content: imageData },
        () => chatService.sendMessage(imageData, "image", undefined, targetId),
        { setLoading: true },
      );
    },
    [sendWithOptimisticUpdate, targetId, peerBlocked, trackSessionObjectUrl],
  );

  const retryFailedMessage = useCallback(
    async (msgId: string) => {
      const failed = chatMessagesRef.current.find((m) => m.id === msgId && m.status === "failed");
      if (!failed || peerBlocked) return;
      setChatMessages((prev) => prev.filter((m) => m.id !== msgId));
      if (failed.type === "text") {
        await sendTextMessage(failed.content);
        return;
      }
      if (failed.type === "image") {
        await sendImageMessage(failed.content);
        return;
      }
      if (failed.type === "voice") {
        const url = failed.audioUrl || failed.content;
        if (!url) return;
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          await sendVoiceMessage(failed.duration || 0, blob);
        } catch (e) {
          console.warn("[Community] retry voice failed", e);
        }
      }
    },
    [peerBlocked, sendTextMessage, sendImageMessage, sendVoiceMessage],
  );

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
