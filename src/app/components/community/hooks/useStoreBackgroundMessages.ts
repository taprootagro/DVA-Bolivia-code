import { useEffect, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../../../utils/supabaseBrowser";
import { ensureEdgeSessionReady } from "../../../utils/auth";
import {
  touchRecentWithPeerEnsure,
  type StorePeerRecord,
} from "../../../services/storeChatDirectory";

function previewFromBroadcast(payload: {
  msg_type?: string;
  body?: string | null;
}): string {
  const t = payload.msg_type;
  if (t === "text") return (payload.body || "").slice(0, 120);
  if (t === "image") return "[Image]";
  if (t === "voice") return "[Voice]";
  if (t === "video") return "[Video]";
  return "";
}

function removeTrackedChannel(
  client: NonNullable<ReturnType<typeof getSupabaseBrowserClient>>,
  channels: RealtimeChannel[],
  ch: RealtimeChannel,
): void {
  try {
    void client.removeChannel(ch);
  } catch {
    /* ignore */
  }
  const idx = channels.indexOf(ch);
  if (idx >= 0) channels.splice(idx, 1);
}

/**
 * Store shell: subscribe to chat:{channelId} broadcast for all bound farmers
 * while the dealer is on recents/contacts (not inside an open thread).
 * Updates recents + unread when farmers send messages.
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

  const peerChannelKey = peers
    .map((p) => `${p.peerKey}:${p.channelId}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (!storeUserId) return;

    const client = getSupabaseBrowserClient();
    if (!client) return;

    let cancelled = false;
    const channels: RealtimeChannel[] = [];
    const seenMessageIds = new Set<string>();

    const cleanupChannels = () => {
      for (const ch of [...channels]) {
        removeTrackedChannel(client, channels, ch);
      }
    };

    void (async () => {
      const edgeToken = await ensureEdgeSessionReady();
      if (cancelled || !edgeToken) return;
      const { data: { session } } = await client.auth.getSession();
      if (cancelled || !session?.access_token) return;
      client.realtime.setAuth(session.access_token);

      for (const peer of peers) {
        if (cancelled) break;
        const channelId = peer.channelId?.trim();
        if (!channelId || channelId === "your-channel-id") continue;
        if (activePeerKey && peer.peerKey === activePeerKey) continue;

        const ch = client.channel(`chat:${channelId}`);
        channels.push(ch);
        if (cancelled) {
          removeTrackedChannel(client, channels, ch);
          break;
        }

        ch.on(
          "broadcast",
          { event: "message" },
          (evt: { payload?: unknown }) => {
            const payload = evt?.payload as {
              id?: string;
              sender_id?: string;
              msg_type?: string;
              body?: string | null;
            } | undefined;
            if (!payload?.id || seenMessageIds.has(payload.id)) return;
            seenMessageIds.add(payload.id);

            const senderId = String(payload.sender_id ?? "");
            const me = storeUserId.trim();
            const incoming = senderId !== "" && senderId.toLowerCase() !== me.toLowerCase();
            if (!incoming) return;

            const preview = previewFromBroadcast(payload);
            void touchRecentWithPeerEnsure(storeUserId, peer, preview, true).then(() => {
              onIncomingRef.current?.(peer, preview);
              onRefreshRef.current();
            });
          },
        );
        ch.subscribe();
        if (cancelled) {
          removeTrackedChannel(client, channels, ch);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanupChannels();
    };
  }, [storeUserId, peerChannelKey, activePeerKey]);
}
