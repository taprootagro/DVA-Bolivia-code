/**
 * Per-user inbox Realtime channel (`inbox:{userId}`, private) + HTTP catch-up.
 * Store shell uses one subscription instead of one channel per farmer.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import type { ChatMessage } from "./ChatProxyService";
import { CONFIG_STORAGE_KEY } from "../constants";
import { storageGet } from "../utils/safeStorage";
import {
  ensureEdgeSessionReady,
  getAccessToken,
  syncAccessTokenFromSupabaseSession,
} from "../utils/auth";
import { getSupabaseBrowserClient } from "../utils/supabaseBrowser";

export type InboxBroadcastRow = {
  id: string;
  channel_id: string;
  sender_id: string;
  msg_type: string;
  body: string | null;
  media_url: string | null;
  duration_ms: number | null;
  created_at: string;
};

export type ChatInboxListener = (evt: {
  channelId: string;
  message: ChatMessage;
  row: InboxBroadcastRow;
}) => void;

const INBOX_CATCHUP_LOOKBACK_MS = 7 * 24 * 3600_000;

const listeners = new Set<ChatInboxListener>();
let activeUserId: string | null = null;
let inboxChannel: RealtimeChannel | null = null;
let lastInboxFetchIso = "";
let catchUpInFlight: Promise<void> | null = null;

function rowToChatMessage(row: InboxBroadcastRow): ChatMessage {
  const t = row.msg_type as ChatMessage["type"];
  const ts = new Date(row.created_at).getTime();
  const base: ChatMessage = {
    id: row.id,
    channelName: row.channel_id,
    senderId: row.sender_id,
    type: t,
    content: t === "text" ? (row.body || "") : (row.media_url || ""),
    timestamp: ts,
    status: "sent",
    read: false,
  };
  if (t === "voice") {
    const sec = row.duration_ms != null ? row.duration_ms / 1000 : 0;
    base.duration = sec > 0 ? Math.max(1, Math.round(sec)) : 5;
    base.audioUrl = row.media_url || undefined;
  }
  return base;
}

function chatSupabaseBaseUrl(): string | null {
  try {
    const saved = storageGet(CONFIG_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as {
      backendProxyConfig?: { supabaseUrl?: string; enabled?: boolean };
    };
    const bpc = parsed.backendProxyConfig;
    const url = (bpc?.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    if (!url || url.includes("your-") || bpc?.enabled === false) return null;
    return `${url}/functions/v1/chat-supabase`;
  } catch {
    return null;
  }
}

function chatHeaders(): HeadersInit {
  const k =
    (() => {
      try {
        const saved = storageGet(CONFIG_STORAGE_KEY);
        if (!saved) return "";
        const parsed = JSON.parse(saved) as {
          backendProxyConfig?: { supabaseAnonKey?: string };
        };
        return (
          parsed.backendProxyConfig?.supabaseAnonKey ||
          import.meta.env.VITE_SUPABASE_ANON_KEY ||
          ""
        ).trim();
      } catch {
        return "";
      }
    })();
  const sessionJwt = getAccessToken()?.trim();
  const authHeader = sessionJwt ? `Bearer ${sessionJwt}` : k ? `Bearer ${k}` : "";
  return {
    "Content-Type": "application/json",
    ...(k ? { Authorization: authHeader, apikey: k } : {}),
  };
}

function dispatchRow(row: InboxBroadcastRow): void {
  const channelId = String(row.channel_id || "").trim();
  if (!channelId || !row.id) return;
  const message = rowToChatMessage(row);
  if (row.created_at && row.created_at > lastInboxFetchIso) {
    lastInboxFetchIso = row.created_at;
  }
  for (const fn of listeners) {
    fn({ channelId, message, row });
  }
}

async function fetchInboxSince(sinceIso: string, limit = 500): Promise<InboxBroadcastRow[]> {
  const base = chatSupabaseBaseUrl();
  if (!base) return [];
  await ensureEdgeSessionReady();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(
      `${base}/inbox?since=${encodeURIComponent(sinceIso)}&limit=${limit}`,
      { method: "GET", headers: chatHeaders(), signal: controller.signal },
    );
    const text = await res.text();
    if (!res.ok) {
      console.warn("[chatInbox] fetch inbox failed", res.status, text);
      return [];
    }
    const data = JSON.parse(text) as { messages?: InboxBroadcastRow[] };
    return data.messages || [];
  } catch (e) {
    console.warn("[chatInbox] fetch inbox error", e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function catchUpInbox(userId: string): Promise<void> {
  if (catchUpInFlight) return catchUpInFlight;
  catchUpInFlight = (async () => {
    const since =
      lastInboxFetchIso ||
      new Date(Date.now() - INBOX_CATCHUP_LOOKBACK_MS).toISOString();
    const rows = await fetchInboxSince(since);
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const row of rows) dispatchRow(row);
  })().finally(() => {
    catchUpInFlight = null;
  });
  return catchUpInFlight;
}

async function teardownInboxChannel(): Promise<void> {
  const client = getSupabaseBrowserClient();
  const ch = inboxChannel;
  inboxChannel = null;
  if (client && ch) {
    try {
      await client.removeChannel(ch);
    } catch {
      /* ignore */
    }
  }
}

async function ensureInboxChannel(userId: string): Promise<void> {
  const uid = userId.trim();
  if (!uid) return;
  if (activeUserId === uid && inboxChannel) return;

  await teardownInboxChannel();
  activeUserId = uid;

  const client = getSupabaseBrowserClient();
  if (!client) return;

  await syncAccessTokenFromSupabaseSession();
  const { data: { session } } = await client.auth.getSession();
  if (session?.access_token) {
    client.realtime.setAuth(session.access_token);
  }

  const ch = client.channel(`inbox:${uid}`, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  inboxChannel = ch;

  ch.on("broadcast", { event: "message" }, (evt: { payload?: unknown }) => {
    const row = evt?.payload as InboxBroadcastRow | undefined;
    if (!row?.id || !row.channel_id) return;
    dispatchRow(row);
  });

  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      void catchUpInbox(uid);
    }
  });
}

function onOnlineOrVisible(): void {
  if (!activeUserId || listeners.size === 0) return;
  void ensureInboxChannel(activeUserId).then(() => catchUpInbox(activeUserId!));
}

let lifecycleBound = false;
function bindLifecycleOnce(): void {
  if (lifecycleBound || typeof window === "undefined") return;
  lifecycleBound = true;
  window.addEventListener("online", onOnlineOrVisible);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onOnlineOrVisible();
  });
}

/**
 * Subscribe to inbox broadcasts + catch-up for `userId`.
 * Returns unsubscribe (does not tear down channel until last listener leaves).
 */
export function subscribeChatInbox(
  userId: string,
  listener: ChatInboxListener,
): () => void {
  bindLifecycleOnce();
  listeners.add(listener);
  void ensureEdgeSessionReady().then(() => ensureInboxChannel(userId));
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      activeUserId = null;
      lastInboxFetchIso = "";
      void teardownInboxChannel();
    }
  };
}
