import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { chatService, type ChatMessage } from "../../../services/ChatProxyService";
import { chatUserService } from "../../../services/ChatUserService";
import { ensureEdgeSessionReady } from "../../../utils/auth";
import {
  cacheMessages as localCacheMessages,
  getRecent as localGetRecent,
  getLatestTimestamp as localGetLatestTs,
} from "../../../services/chatLocalStore";
import { bridge, isNative } from "../../../utils/capacitor-bridge";
import { recallThread, rememberThread, retainObjectUrl } from "../../../services/chatUiMemory";
import { previewFromMessage } from "./useChatSend";
import type { Translations } from "../../../hooks/useLanguage";

export type UseChatChannelLifecycleArgs = {
  currentUserId: string | null | undefined;
  channelId: string;
  targetImUserId: string;
  peerBlocked: boolean;
  pageSize: number;
  capMessages: (list: ChatMessage[]) => ChatMessage[];
  ensureMediaCached: (msg: ChatMessage) => void;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setFirstItemIndex: Dispatch<SetStateAction<number>>;
  setProxyMode: Dispatch<SetStateAction<"backend" | "mock">>;
  setProviderName: Dispatch<SetStateAction<string>>;
  setRealtimeError: Dispatch<SetStateAction<string | null>>;
  setHasMoreOlder: Dispatch<SetStateAction<boolean>>;
  pendingFrontTrimRef: MutableRefObject<number>;
  lastSeenTsRef: MutableRefObject<number>;
  hasMoreOlderRef: MutableRefObject<boolean>;
  chatMessagesRef: MutableRefObject<ChatMessage[]>;
  sessionObjectURLsRef: MutableRefObject<Set<string>>;
  mediaResolvedIdsRef: MutableRefObject<Set<string>>;
  resumeFnRef: MutableRefObject<(() => Promise<void>) | null>;
  markActivityRef: MutableRefObject<() => void>;
  communityTRef: MutableRefObject<Translations["community"]>;
  onDirectoryActivityRef: MutableRefObject<((args: { preview: string; incoming: boolean }) => void) | undefined>;
  onResumeCatchUpRef: MutableRefObject<((missedIncoming: ChatMessage[]) => void) | undefined>;
};

/** Join / resume / idle / visibility lifecycle for one chat channel. */
export function useChatChannelLifecycle({
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
}: UseChatChannelLifecycleArgs) {
  useEffect(() => {
    const liveError = (kind: "failed" | "connect" | "reconnect") => {
      const ct = communityTRef.current;
      if (kind === "failed") {
        return ct?.liveChatFailed || "Live chat connection failed — you may not receive new messages until you reopen this chat.";
      }
      if (kind === "reconnect") {
        return ct?.liveChatReconnectFailed || "Could not reconnect to live chat — pull to refresh or reopen this conversation.";
      }
      return ct?.liveChatConnectFailed || "Could not connect to live chat — pull to refresh or reopen this conversation.";
    };
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

    const cachedThread = recallThread(channelId);
    if (cachedThread && cachedThread.length > 0) {
      setChatMessages(cachedThread);
      const maxTs = cachedThread.reduce((acc, x) => (x.timestamp > acc ? x.timestamp : acc), 0);
      lastSeenTsRef.current = maxTs;
      hasMoreOlderRef.current = true;
      setHasMoreOlder(true);
    } else {
      setChatMessages([]);
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
      // 落 IndexedDB + 预取媒体 blob（云端 7d 后会被清理）
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
            msg.includes("CHAT_REALTIME") ? liveError("failed") : liveError("connect"),
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

      chatService.attachRealtime();
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
            msg.includes("CHAT_REALTIME") ? liveError("failed") : liveError("reconnect"),
          );
        }
      }
      if (cancelled || mySeq !== resumeSeq) return;

      // 重新订阅前先回种 dedup 集合（leaveChannel 已清空 _seenMessageIds）
      chatService.markSeen(chatMessagesRef.current.map((m) => m.id));
      chatService.attachRealtime();
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
      rememberThread(channelId, chatMessagesRef.current);
      // 保留 blob URL，二次打开同一会话不用重新解码
      for (const u of sessionObjectURLsRef.current) {
        retainObjectUrl(u);
      }
      sessionObjectURLsRef.current.clear();
      mediaResolvedIdsRef.current.clear();
    };
  }, [currentUserId, channelId, targetImUserId, peerBlocked, capMessages, ensureMediaCached]);

}
