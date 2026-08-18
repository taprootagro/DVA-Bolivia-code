// ============================================================================
// storeBindingRepo — store-side view of merchant_farmer_channels
// ============================================================================
// Supabase 的 merchant_farmer_channels 在 RLS 下允许门店用自己的 JWT SELECT
// 属于自己的行（merchant_user_id = auth.uid()）。本模块封装：
//   1. syncStorePeersFromCloud(storeUserId): 拉取所有绑定行 + 对应农户的
//      user_profiles，一次性 upsert 进 IndexedDB（storeChatDirectory）。
//   2. subscribeStorePeerInserts(storeUserId, onNewBinding): 监听 Realtime
//      INSERT 事件，有新农户扫码绑定时触发回调（用于实时刷新列表）。
// ============================================================================

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../utils/supabaseBrowser";
import { ensureEdgeSessionReady } from "../utils/auth";
import { makePeerKey, upsertPeer } from "./storeChatDirectory";

interface ChannelRow {
  merchant_user_id: string;
  farmer_user_id: string;
  channel_id: string;
  created_at: string;
}

interface ProfileRow {
  user_id: string;
  profile: Record<string, unknown> | null;
  display_name?: string | null;
  avatar_url?: string | null;
}

/** 与 farmerBindingRepo / merchant-bind-resolve 一致：列优先，再 profile JSON（含 nickname） */
function pickProfileFields(
  profile: Record<string, unknown> | null | undefined,
  displayNameCol?: string | null,
  avatarUrlCol?: string | null,
): {
  name: string;
  avatar: string;
  subtitle: string;
} {
  const p = profile || {};
  const asStr = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    name:
      (displayNameCol && asStr(displayNameCol)) ||
      asStr(p.name) ||
      asStr((p as Record<string, unknown>).displayName) ||
      asStr((p as Record<string, unknown>).full_name) ||
      asStr((p as Record<string, unknown>).nickname) ||
      "",
    avatar:
      (avatarUrlCol && asStr(avatarUrlCol)) ||
      asStr(p.avatar) ||
      asStr((p as Record<string, unknown>).avatar_url) ||
      asStr((p as Record<string, unknown>).picture) ||
      "",
    subtitle:
      asStr(p.subtitle) ||
      asStr((p as Record<string, unknown>).bio) ||
      asStr((p as Record<string, unknown>).description) ||
      "",
  };
}

/**
 * Pull all farmers that have ever bound this store, enrich with user_profiles,
 * and upsert them into the local IndexedDB store directory.
 * RLS ensures only rows where merchant_user_id = auth.uid() are returned.
 */
/** Ensure browser Supabase client has JWT before RLS-backed queries / Realtime. */
async function ensureStoreClientSession(
  client: NonNullable<ReturnType<typeof getSupabaseBrowserClient>>,
  storeUserId: string,
): Promise<boolean> {
  // Google/OAuth：session 在 taprootagro-auth（含 cookie 跨 PWA↔Safari）；必要时 refresh
  const edgeToken = await ensureEdgeSessionReady();
  if (!edgeToken) {
    console.error(
      "[storeBindingRepo] no valid OAuth/session token — sign in again (Google OAuth / OTP)",
    );
    return false;
  }
  const { data: { session }, error: sessErr } = await client.auth.getSession();
  if (sessErr) {
    console.error("[storeBindingRepo] getSession failed", sessErr);
    return false;
  }
  const uid = session?.user?.id?.trim();
  if (!uid) {
    console.error(
      "[storeBindingRepo] no Supabase session — merchant_farmer_channels query will run as anon and return 0 rows",
    );
    return false;
  }
  if (uid.toLowerCase() !== storeUserId.trim().toLowerCase()) {
    console.error(
      "[storeBindingRepo] session uid mismatch",
      { sessionUid: uid, storeUserId },
    );
    return false;
  }
  if (session?.access_token) {
    client.realtime.setAuth(session.access_token);
  }
  return true;
}

export async function syncStorePeersFromCloud(storeUserId: string): Promise<number> {
  const client = getSupabaseBrowserClient();
  if (!client) return 0;

  const sessionOk = await ensureStoreClientSession(client, storeUserId);
  if (!sessionOk) return 0;

  const { data: rows, error } = await client
    .from("merchant_farmer_channels")
    .select("merchant_user_id, farmer_user_id, channel_id, created_at")
    .eq("merchant_user_id", storeUserId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[storeBindingRepo] fetch channels", error);
    return 0;
  }
  if (!rows?.length) {
    console.warn(
      "[storeBindingRepo] fetch channels returned 0 rows",
      { storeUserId },
    );
    return 0;
  }

  const farmerIds = Array.from(new Set(rows.map((r) => r.farmer_user_id).filter(Boolean)));
  const profiles = new Map<string, { name: string; avatar: string; subtitle: string }>();

  if (farmerIds.length) {
    const { data: profRows, error: profErr } = await client
      .from("user_profiles")
      .select("user_id, profile, display_name, avatar_url")
      .in("user_id", farmerIds);
    if (!profErr && profRows) {
      for (const r of profRows as ProfileRow[]) {
        profiles.set(
          r.user_id,
          pickProfileFields(r.profile, r.display_name, r.avatar_url),
        );
      }
    } else if (profErr) {
      console.warn("[storeBindingRepo] fetch profiles", profErr);
    }
  }

  let synced = 0;
  for (const row of rows as ChannelRow[]) {
    const farmerUserId = row.farmer_user_id;
    const channelId = row.channel_id;
    if (!farmerUserId || !channelId) continue;
    const prof = profiles.get(farmerUserId);
    const peerKey = makePeerKey(channelId, farmerUserId);
    try {
      await upsertPeer(storeUserId, {
        peerKey,
        name: prof?.name || "",
        avatar: prof?.avatar || "",
        subtitle: prof?.subtitle || "",
        imUserId: farmerUserId,
        channelId,
        imProvider: "supabase",
        phone: "",
        storeId: "",
      });
      synced += 1;
    } catch (e) {
      console.warn("[storeBindingRepo] upsertPeer", e);
    }
  }
  return synced;
}

/**
 * Subscribe to INSERT events on merchant_farmer_channels for this store.
 * Triggers `onNewBinding` whenever a farmer scans the store QR.
 *
 * Returns an unsubscribe function.
 */
export function subscribeStorePeerInserts(
  storeUserId: string,
  onNewBinding: () => void,
): () => void {
  const client = getSupabaseBrowserClient();
  if (!client) return () => {};

  let cancelled = false;
  let channel: RealtimeChannel | null = null;

  const removeChannel = () => {
    if (!channel) return;
    try {
      void client.removeChannel(channel);
    } catch (e) {
      console.warn("[storeBindingRepo] removeChannel", e);
    }
    channel = null;
  };

  void ensureStoreClientSession(client, storeUserId).then((ok) => {
    if (!ok || cancelled) return;
    try {
      const ch = client
        .channel(`store-peers:${storeUserId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "merchant_farmer_channels",
            filter: `merchant_user_id=eq.${storeUserId}`,
          },
          () => {
            try {
              onNewBinding();
            } catch (e) {
              console.warn("[storeBindingRepo] onNewBinding handler", e);
            }
          },
        );
      if (cancelled) {
        try {
          void client.removeChannel(ch);
        } catch {
          /* ignore */
        }
        return;
      }
      channel = ch;
      ch.subscribe();
      if (cancelled) {
        removeChannel();
      }
    } catch (e) {
      console.warn("[storeBindingRepo] subscribe", e);
    }
  });

  return () => {
    cancelled = true;
    removeChannel();
  };
}
