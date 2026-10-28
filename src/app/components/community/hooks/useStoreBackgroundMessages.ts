import { useEffect, useRef } from "react";
import { subscribeChatInbox } from "../../../services/chatInbox";
import {
  cacheMessages,
  hasLocalMessageId,
} from "../../../services/chatLocalStore";
import {
  touchRecentWithPeerEnsure,
  type StorePeerRecord,
} from "../../../services/storeChatDirectory";

function previewFromMessage(msg: {
  msg_type?: string;
  body?: string | null;
}): string {
  const t = msg.msg_type;
  if (t === "text") return (msg.body || "").slice(0, 120);
  if (t === "image") return "[Image]";
  if (t === "voice") return "[Voice]";
  if (t === "video") return "[Video]";
  return "";
}

function peerForChannel(
  peers: StorePeerRecord[],
  channelId: string,
): StorePeerRecord | null {
  const cid = channelId.trim();
  if (!cid) return null;
  return peers.find((p) => p.channelId?.trim() === cid) ?? null;
}

const REFRESH_DEBOUNCE_MS = 300;

/**
 * Store shell: single inbox:{storeUserId} subscription + local message cache.
 */
export function useStoreBackgroundMessages(
  storeUserId: string,
  peers: StorePeerRecord[],
  activePeerKey: string | null,
  onRefresh: () => void,
  onIncoming?: (peer: StorePeerRecord, preview: string) => void,
): void {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const onIncomingRef = useRef(onIncoming);
  onIncomingRef.current = onIncoming;
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const activePeerKeyRef = useRef(activePeerKey);
  activePeerKeyRef.current = activePeerKey;
  const storeUserIdRef = useRef(storeUserId);
  storeUserIdRef.current = storeUserId;

  useEffect(() => {
    if (!storeUserId) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        onRefreshRef.current();
      }, REFRESH_DEBOUNCE_MS);
    };

    const unsub = subscribeChatInbox(storeUserId, ({ channelId, message, row }) => {
      const me = storeUserIdRef.current.trim().toLowerCase();
      const senderId = String(row.sender_id ?? "").toLowerCase();
      const incoming = senderId !== "" && senderId !== me;
      if (!incoming) return;

      const peer = peerForChannel(peersRef.current, channelId);
      if (!peer) return;

      void (async () => {
        const existed = await hasLocalMessageId(message.id);
        await cacheMessages([message]);

        const inActiveThread =
          activePeerKeyRef.current != null &&
          activePeerKeyRef.current === peer.peerKey;
        const bumpUnread = !existed && !inActiveThread;
        const preview = previewFromMessage(row);
        await touchRecentWithPeerEnsure(
          storeUserIdRef.current,
          peer,
          preview,
          bumpUnread,
        );
        if (bumpUnread) {
          onIncomingRef.current?.(peer, preview);
        }
        scheduleRefresh();
      })();
    });

    return () => {
      unsub();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [storeUserId]);
}
