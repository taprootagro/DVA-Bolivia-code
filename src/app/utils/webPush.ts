import { CONFIG_STORAGE_KEY } from "../constants";
import { storageGetJSON } from "./safeStorage";
import { defaultConfig } from "/taprootagrosetting";
import type { HomePageConfig } from "../hooks/useHomeConfig";
import { deepMerge, MERGE_REPLACE } from "./index";

interface PushEndpointConfig {
  pushConfig?: { pushApiBase?: string };
  pushProvidersConfig?: { webpush?: { pushApiBase?: string } };
  backendProxyConfig?: { supabaseUrl?: string; edgeFunctionName?: string };
}

/** Edge base for /push/subscribe and /push/unsubscribe ("" when not configured). */
export function resolvePushApiBase(cfg: PushEndpointConfig): string {
  const bp = cfg.backendProxyConfig;
  const derivedFromSupabase = () => {
    const url = (bp?.supabaseUrl || "").trim().replace(/\/$/, "");
    const fn = (bp?.edgeFunctionName || "server").trim() || "server";
    if (url.length > 0 && url.startsWith("http")) {
      return `${url}/functions/v1/${fn}`;
    }
    return "";
  };

  const normalizePushApiBase = (raw: string) => {
    const base = raw.trim().replace(/\/$/, "");
    if (!base || base === "https://api.example.com" || base.length <= 8) return "";
    // Bare host without Edge Function path — use standard Supabase layout.
    if (!base.includes("/functions/v1/")) {
      const derived = derivedFromSupabase();
      if (derived) return derived;
    }
    return base;
  };

  const fromWebpush = normalizePushApiBase(cfg.pushProvidersConfig?.webpush?.pushApiBase || "");
  if (fromWebpush) return fromWebpush;
  const fromPushConfig = normalizePushApiBase(cfg.pushConfig?.pushApiBase || "");
  if (fromPushConfig) return fromPushConfig;
  return derivedFromSupabase();
}

function mergedHomeConfig(): HomePageConfig {
  const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  if (parsed) {
    return deepMerge(
      defaultConfig as unknown as Record<string, unknown>,
      parsed as unknown as Record<string, unknown>,
      MERGE_REPLACE,
    ) as unknown as HomePageConfig;
  }
  return defaultConfig;
}

const UNBIND_NETWORK_TIMEOUT_MS = 2500;

/**
 * Logout / account deletion: drop this browser's Web Push registration — the backend row while the
 * session is still valid, then the browser subscription itself — so a shared device stops receiving
 * the previous user's notifications. The network part is capped so logout never stalls on it.
 */
export async function unbindWebPush(getAccessToken: () => Promise<string | null>): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  let sub: PushSubscription | null | undefined;
  try {
    // getRegistration(), not .ready: .ready never settles when no service worker is registered.
    const reg = await navigator.serviceWorker.getRegistration();
    sub = await reg?.pushManager?.getSubscription();
  } catch {
    return;
  }
  if (!sub) return;

  const cfg = mergedHomeConfig();
  const base = resolvePushApiBase(cfg);
  if (base) {
    const anon = (cfg.backendProxyConfig?.supabaseAnonKey || "").trim();
    const endpoint = sub.endpoint;
    const removeBackendRow = async () => {
      const token = await getAccessToken();
      if (!token) return;
      await fetch(`${base}/push/unsubscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(anon ? { apikey: anon } : {}),
        },
        body: JSON.stringify({ endpoint }),
      });
    };
    try {
      await Promise.race([
        removeBackendRow(),
        new Promise<void>((resolve) => setTimeout(resolve, UNBIND_NETWORK_TIMEOUT_MS)),
      ]);
    } catch {
      /* best effort: once unsubscribed below, the push service rejects the endpoint and send prunes the row */
    }
  }

  try {
    await sub.unsubscribe();
  } catch {
    /* ignore */
  }
}
