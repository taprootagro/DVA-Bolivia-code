import { CONFIG_STORAGE_KEY, PROFILE_GATE_DISMISSED_SESSION_KEY } from "../constants";
import { purgeAllChatLocalData } from "../services/chatLocalStore";
import {
  clearAuthData,
  ensureEdgeSessionReady,
  isServerAssignedId,
  TAPROOT_AUTH_CHANGE_EVENT,
} from "./auth";
import { clearContentSuperAdminCache } from "./contentSuperAdminCache";
import { clearEdgeProfileCache } from "./edgeProfileCache";
import { storageGetJSON, storageRemove } from "./safeStorage";
import { getSupabaseBrowserClient, invalidateSupabaseBrowserClientCache } from "./supabaseBrowser";
import { defaultConfig } from "/taprootagrosetting";
import type { HomePageConfig } from "../hooks/useHomeConfig";
import { deepMerge, MERGE_REPLACE } from "./index";

export const DELETED_SENDER_PREFIX = "deleted:";

export function isDeletedSenderId(senderId: string | null | undefined): boolean {
  const id = (senderId ?? "").trim();
  return id === "deleted_user" || id.startsWith(DELETED_SENDER_PREFIX);
}

export function deletedSenderIdForUser(userId: string): string {
  return `${DELETED_SENDER_PREFIX}${userId.slice(0, 8)}`;
}

export function isUserAnonymizedAsDeleted(
  userId: string | null | undefined,
  senderId: string | null | undefined,
): boolean {
  const uid = (userId ?? "").trim();
  if (!uid || !isDeletedSenderId(senderId)) return false;
  return senderId === deletedSenderIdForUser(uid);
}

function mergedHomeConfig(): HomePageConfig {
  const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  if (parsed) return deepMerge(defaultConfig, parsed, MERGE_REPLACE);
  return defaultConfig;
}

function getAccountDeleteEndpoint(): string | null {
  const bp = mergedHomeConfig().backendProxyConfig;
  const url = String(bp?.supabaseUrl || "").trim();
  const anon = String(bp?.supabaseAnonKey || "").trim();
  if (!url || url.includes("your-") || !anon || bp?.enabled === false) return null;
  const fn = (bp?.edgeFunctionName || "server").replace(/^\//, "");
  return `${url.replace(/\/+$/, "")}/functions/v1/${fn}/account/delete`;
}

export async function clearLocalAccountData(): Promise<void> {
  try {
    await getSupabaseBrowserClient()?.auth.signOut();
  } catch {
    /* ignore */
  }
  clearContentSuperAdminCache();
  clearEdgeProfileCache();
  invalidateSupabaseBrowserClientCache();
  clearAuthData();
  await purgeAllChatLocalData();
  try {
    sessionStorage.removeItem(PROFILE_GATE_DISMISSED_SESSION_KEY);
  } catch {
    /* ignore */
  }
  try {
    storageRemove("taproot-push-subscribed");
  } catch {
    /* ignore */
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(TAPROOT_AUTH_CHANGE_EVENT));
    }
  } catch {
    /* ignore */
  }
}

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; error: string; status?: number };

export async function deleteAccount(): Promise<DeleteAccountResult> {
  if (!isServerAssignedId()) {
    await clearLocalAccountData();
    return { ok: true };
  }

  const endpoint = getAccountDeleteEndpoint();
  if (!endpoint) {
    await clearLocalAccountData();
    return { ok: true };
  }

  const token = await ensureEdgeSessionReady();
  if (!token) {
    return { ok: false, error: "session_expired", status: 401 };
  }

  const anon = String(mergedHomeConfig().backendProxyConfig?.supabaseAnonKey || "").trim();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(anon ? { apikey: anon } : {}),
      },
      body: "{}",
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  if (!res.ok) {
    let message = "delete_failed";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    return { ok: false, error: message, status: res.status };
  }

  await clearLocalAccountData();
  return { ok: true };
}
