// ============================================================================
// farmerBindingRepo — farmer-side cloud rehydration of chatContact
// ============================================================================
// farmer_merchant_bindings RLS: farmer_user_id = auth.uid() can SELECT/DELETE.
// When the farmer signs in on a new device, call findLatestBinding() to
// recover the bound merchant's channel + profile so chatContact is populated
// without re-scanning the store's QR.
// ============================================================================

import { CONFIG_STORAGE_KEY } from "../constants";
import { ensureEdgeSessionReady, getAccessToken } from "../utils/auth";
import { storageGet } from "../utils/safeStorage";
import { getSupabaseBrowserClient } from "../utils/supabaseBrowser";

export interface FarmerBinding {
  merchantUserId: string;
  channelId: string;
  name: string;
  avatar: string;
  subtitle: string;
  createdAt: string;
}

interface BindingRow {
  merchant_user_id: string;
  channel_id: string;
  created_at: string;
}

interface ProfileRow {
  user_id: string;
  profile: Record<string, unknown> | null;
  display_name?: string | null;
  avatar_url?: string | null;
}

/** 与 merchant-bind-resolve extractMerchantProfile 一致：列优先，再 profile JSON */
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

/** List all merchants this farmer is bound to (newest first). */
export async function listMyBindings(): Promise<FarmerBinding[]> {
  const client = getSupabaseBrowserClient();
  if (!client) return [];

  const { data: rows, error } = await client
    .from("farmer_merchant_bindings")
    .select("merchant_user_id, channel_id, created_at")
    .order("created_at", { ascending: false });

  if (error || !rows?.length) {
    if (error) console.warn("[farmerBindingRepo] list", error);
    return [];
  }

  const merchantIds = (rows as BindingRow[]).map((r) => r.merchant_user_id);
  const profiles = new Map<string, { name: string; avatar: string; subtitle: string }>();
  const { data: profRows, error: profErr } = await client
    .from("user_profiles")
    .select("user_id, profile, display_name, avatar_url")
    .in("user_id", merchantIds);
  if (!profErr && profRows) {
    for (const r of profRows as ProfileRow[]) {
      profiles.set(
        r.user_id,
        pickProfileFields(r.profile, r.display_name, r.avatar_url),
      );
    }
  }

  return (rows as BindingRow[]).map((r) => {
    const p = profiles.get(r.merchant_user_id);
    return {
      merchantUserId: r.merchant_user_id,
      channelId: r.channel_id,
      name: p?.name || "",
      avatar: p?.avatar || "",
      subtitle: p?.subtitle || "",
      createdAt: r.created_at,
    };
  });
}

/** GET /messages limit=1 — 403 means local chatContact is stale. */
export async function verifyChannelReadAccess(
  channelId: string,
): Promise<"ok" | "forbidden" | "error"> {
  const cid = channelId.trim();
  if (!cid) return "error";
  try {
    const saved = storageGet(CONFIG_STORAGE_KEY);
    const parsed = saved ? (JSON.parse(saved) as { backendProxyConfig?: { supabaseUrl?: string; supabaseAnonKey?: string } }) : {};
    const bpc = parsed.backendProxyConfig;
    const base = (bpc?.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    const anon = (bpc?.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();
    if (!base || !anon) return "error";
    await ensureEdgeSessionReady();
    const token = getAccessToken()?.trim();
    const authHeader = token ? `Bearer ${token}` : `Bearer ${anon}`;
    const res = await fetch(
      `${base}/functions/v1/chat-supabase/messages?channel_id=${encodeURIComponent(cid)}&limit=1`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json", apikey: anon, Authorization: authHeader },
      },
    );
    if (res.status === 403) return "forbidden";
    if (!res.ok) return "error";
    return "ok";
  } catch {
    return "error";
  }
}

/** Most recent binding (for auto-restoring chatContact on login). */
export async function findLatestBinding(): Promise<FarmerBinding | null> {
  const all = await listMyBindings();
  return all[0] ?? null;
}

/** Remove a binding from the cloud (farmer can DELETE own rows via RLS). */
export async function removeBinding(merchantUserId: string): Promise<boolean> {
  const client = getSupabaseBrowserClient();
  if (!client) return false;
  const { error } = await client
    .from("farmer_merchant_bindings")
    .delete()
    .eq("merchant_user_id", merchantUserId);
  if (error) {
    console.warn("[farmerBindingRepo] remove", error);
    return false;
  }
  return true;
}
