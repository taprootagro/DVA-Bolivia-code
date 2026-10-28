import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { chatService, type ChatMessage } from "../../../services/ChatProxyService";
import { cacheMessages as localCacheMessages, deleteLocalMessage } from "../../../services/chatLocalStore";
import type { Translations } from "../../../hooks/useLanguage";

export function previewFromMessage(msg: ChatMessage): string {
  if (msg.type === "text") return (msg.content || "").slice(0, 120);
  if (msg.type === "image") return "[Image]";
  if (msg.type === "voice") return "[Voice]";
  if (msg.type === "video") return "[Video]";
  return "";
}

type UseChatSendArgs = {
  channelId: string;
  targetId: string;
  currentUserId: string;
  peerBlocked: boolean;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsSending: Dispatch<SetStateAction<boolean>>;
  setRealtimeError: Dispatch<SetStateAction<string | null>>;
  revokeOptimisticMediaUrls: (msg: ChatMessage) => void;
  ensureMediaCachedRef: MutableRefObject<(msg: ChatMessage) => void>;
  trackSessionObjectUrl: (url: string | undefined) => void;
  onDirectoryActivityRef: MutableRefObject<((args: { preview: string; incoming: boolean }) => void) | undefined>;
  communityTRef: MutableRefObject<Translations["community"]>;
  chatMessagesRef: MutableRefObject<ChatMessage[]>;
};

/** Optimistic send / retry for text, image, and voice. */
export function useChatSend({
  channelId,
  targetId,
  currentUserId,
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
}: UseChatSendArgs) {
  const sendInFlightRef = useRef(false);
  const rateLimitClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendWithOptimisticUpdate = useCallback(
    async (
      msgOverrides: Partial<ChatMessage> & { type: ChatMessage["type"] },
      serviceSend: (clientMsgId: string) => Promise<ChatMessage>,
      sendOpts?: { setLoading?: boolean; reuseId?: string },
    ) => {
      if (peerBlocked) {
        if (sendOpts?.setLoading) setIsSending(false);
        return;
      }
      if (sendInFlightRef.current) return;
      sendInFlightRef.current = true;
      if (sendOpts?.setLoading) setIsSending(true);

      const clientMsgId =
        sendOpts?.reuseId?.trim() ||
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `m${Date.now()}_opt`);

      const optimisticMsg: ChatMessage = {
        id: clientMsgId,
        channelName: channelId || "default-channel",
        senderId: currentUserId || "",
        content: "",
        timestamp: Date.now(),
        status: "sending",
        read: false,
        ...msgOverrides,
      };

      setChatMessages((prev) => {
        const withoutDup = prev.filter((m) => m.id !== clientMsgId);
        return [...withoutDup, optimisticMsg];
      });
      void localCacheMessages([optimisticMsg]);

      try {
        const sentMsg = await serviceSend(clientMsgId);
        if (sentMsg.id !== optimisticMsg.id) {
          revokeOptimisticMediaUrls(optimisticMsg);
          void deleteLocalMessage(optimisticMsg.id);
        } else if (sentMsg.status === "sent") {
          revokeOptimisticMediaUrls(optimisticMsg);
        }
        setChatMessages((prev) =>
          prev.map((m) => (m.id === optimisticMsg.id ? { ...sentMsg } : m)),
        );
        if (sentMsg.status === "sent") {
          void localCacheMessages([sentMsg]);
          ensureMediaCachedRef.current(sentMsg);
          if (onDirectoryActivityRef.current) {
            onDirectoryActivityRef.current({ preview: previewFromMessage(sentMsg), incoming: false });
          }
        } else if (sentMsg.status === "failed") {
          void localCacheMessages([sentMsg]);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.startsWith("CHAT_RATE_LIMIT")) {
          const secs = parseInt(errMsg.split(":")[1] || "0", 10);
          const ct = communityTRef.current;
          const notice =
            secs > 0
              ? (ct?.sendTooFastWait || "Sending too fast — wait {seconds}s before retrying.")
                  .replace(/\{seconds\}/g, String(secs))
              : ct?.sendTooFast || "Sending too fast — please wait before retrying.";
          setRealtimeError(notice);
          if (rateLimitClearTimerRef.current) clearTimeout(rateLimitClearTimerRef.current);
          rateLimitClearTimerRef.current = setTimeout(() => {
            rateLimitClearTimerRef.current = null;
            setRealtimeError((cur) => (cur === notice ? null : cur));
          }, (secs > 0 ? secs : 5) * 1000);
        }
        const failedMsg = { ...optimisticMsg, status: "failed" as const };
        setChatMessages((prev) =>
          prev.map((m) => (m.id === optimisticMsg.id ? failedMsg : m)),
        );
        void localCacheMessages([failedMsg]);
      } finally {
        sendInFlightRef.current = false;
        if (sendOpts?.setLoading) setIsSending(false);
      }
    },
    [channelId, communityTRef, currentUserId, ensureMediaCachedRef, onDirectoryActivityRef, peerBlocked, revokeOptimisticMediaUrls, setChatMessages, setIsSending, setRealtimeError],
  );

  useEffect(
    () => () => {
      if (rateLimitClearTimerRef.current) clearTimeout(rateLimitClearTimerRef.current);
    },
    [],
  );

  const sendTextMessage = useCallback(
    async (content: string) => {
      if (peerBlocked) return;
      await sendWithOptimisticUpdate(
        { type: "text", content },
        (clientMsgId) =>
          chatService.sendMessage(content, "text", undefined, targetId, undefined, undefined, clientMsgId),
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
        (clientMsgId) =>
          chatService.sendMessage("", "voice", duration, targetId, audioBlob, undefined, clientMsgId),
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
        (clientMsgId) =>
          chatService.sendMessage(imageData, "image", undefined, targetId, undefined, undefined, clientMsgId),
        { setLoading: true },
      );
    },
    [sendWithOptimisticUpdate, targetId, peerBlocked, trackSessionObjectUrl],
  );

  const retryFailedMessage = useCallback(
    async (msgId: string) => {
      const pending = chatMessagesRef.current.find(
        (m) => m.id === msgId && (m.status === "failed" || m.status === "sending"),
      );
      if (!pending || peerBlocked || sendInFlightRef.current) return;

      if (pending.type === "text") {
        await sendWithOptimisticUpdate(
          { type: "text", content: pending.content },
          (clientMsgId) =>
            chatService.sendMessage(pending.content, "text", undefined, targetId, undefined, undefined, clientMsgId),
          { reuseId: pending.id },
        );
        return;
      }
      if (pending.type === "image") {
        await sendWithOptimisticUpdate(
          { type: "image", content: pending.content },
          (clientMsgId) =>
            chatService.sendMessage(pending.content, "image", undefined, targetId, undefined, undefined, clientMsgId),
          { reuseId: pending.id },
        );
        return;
      }
      if (pending.type === "voice") {
        const url = pending.audioUrl || pending.content;
        if (!url) return;
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          const localAudioUrl = url.startsWith("blob:") ? url : URL.createObjectURL(blob);
          if (!url.startsWith("blob:")) trackSessionObjectUrl(localAudioUrl);
          await sendWithOptimisticUpdate(
            { type: "voice", content: localAudioUrl, duration: pending.duration, audioUrl: localAudioUrl },
            (clientMsgId) =>
              chatService.sendMessage("", "voice", pending.duration, targetId, blob, undefined, clientMsgId),
            { reuseId: pending.id },
          );
        } catch (e) {
          console.warn("[Community] retry voice failed", e);
        }
      }
    },
    [peerBlocked, sendWithOptimisticUpdate, targetId, trackSessionObjectUrl, chatMessagesRef],
  );

  return { sendTextMessage, sendVoiceMessage, sendImageMessage, retryFailedMessage, sendInFlightRef };
}
