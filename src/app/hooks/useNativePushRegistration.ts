import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useConfigContext } from "./ConfigProvider";
import { getAccessToken, getServerUserId, isUserLoggedIn } from "../utils/auth";
import { isNative, pushNotifications, jpush } from "../utils/capacitor-bridge";
import { storageGet } from "../utils/safeStorage";
import type { HomePageConfig } from "./useHomeConfig";

/** Resolve in-app path from FCM / JPush data payload (see supabase/functions/_shared/push.ts). */
export function resolvePushNavigationPath(
  data?: Record<string, unknown> | null,
): string | null {
  if (!data) return null;
  const route = String(data.route ?? data.path ?? "").trim();
  if (route.startsWith("/")) return route;

  const channelId = String(data.channel_id ?? data.channelId ?? "").trim();
  if (channelId) return "/home/community";

  return null;
}

/**
 * Capacitor 原生环境：注册 FCM token / JPush regId 并 POST 到 server /push/subscribe。
 * 根据 pushProvidersConfig.activeProvider 自动选择推送平台。
 * 登录后通过 storage / focus 重试；点击通知深链到社区等页面。
 */
export function useNativePushRegistration() {
  const navigate = useNavigate();
  const { config } = useConfigContext();
  const lastPostedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isNative()) return;

    const handlePushOpen = (raw?: Record<string, unknown> | null) => {
      const path = resolvePushNavigationPath(raw);
      if (path) {
        navigate(path, { replace: false });
      }
    };

    let fcmActionCleanup: (() => void) | null = null;
    let jpushOpenCleanup: (() => void) | null = null;

    void pushNotifications.onActionPerformed((action) => {
      handlePushOpen(action.data as Record<string, unknown> | undefined);
    }).then((cleanup) => {
      fcmActionCleanup = cleanup;
    });

    void jpush.onOpened((payload) => {
      const raw = payload.rawData;
      if (raw && typeof raw === "object") {
        handlePushOpen(raw as Record<string, unknown>);
      }
    }).then((cleanup) => {
      jpushOpenCleanup = cleanup;
    });

    const cfg = config as HomePageConfig;
    const bp = cfg.backendProxyConfig;
    const ppc = cfg.pushProvidersConfig;
    const url = (bp?.supabaseUrl || "").trim().replace(/\/$/, "");
    const anon = (bp?.supabaseAnonKey || "").trim();
    const fn = (bp?.edgeFunctionName || "server").trim() || "server";
    if (!url || !anon) {
      return () => {
        fcmActionCleanup?.();
        jpushOpenCleanup?.();
      };
    }

    const base = `${url}/functions/v1/${fn}`;

    let cancelled = false;

    const tryRegister = async () => {
      if (cancelled) return;
      if (!isUserLoggedIn()) {
        lastPostedKeyRef.current = null;
        return;
      }
      const jwt = getAccessToken();
      if (!jwt) return;
      const uid = getServerUserId();
      if (!uid) return;

      const language = (storageGet("app-language") || "").trim() || undefined;

      const result = await pushNotifications.register();
      if (cancelled) return;
      if (result?.token) {
        const dedupeKey = `${uid}:${result.token}:${language || ""}`;
        if (lastPostedKeyRef.current !== dedupeKey) {
          try {
            const res = await fetch(`${base}/push/subscribe`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${jwt}`,
                apikey: anon,
              },
              body: JSON.stringify({
                platform: "fcm",
                token: result.token,
                ...(language ? { language } : {}),
              }),
            });
            if (res.ok) {
              lastPostedKeyRef.current = dedupeKey;
              console.log("[NativePush] FCM token registered with server");
            } else {
              console.warn("[NativePush] FCM register failed", await res.text());
            }
          } catch (e) {
            console.warn("[NativePush] FCM register error", e);
          }
        }
      }

      if (cancelled) return;
      if (ppc?.activeProvider === "jpush" && ppc.jpush?.enabled) {
        try {
          await jpush.start();
          const regId = await jpush.getRegistrationId();
          if (regId) {
            const jpushKey = `${uid}:${regId}:${language || ""}`;
            if (lastPostedKeyRef.current !== jpushKey) {
              const res = await fetch(`${base}/push/subscribe`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${jwt}`,
                  apikey: anon,
                },
                body: JSON.stringify({
                  platform: "jpush",
                  token: regId,
                  ...(language ? { language } : {}),
                }),
              });
              if (res.ok) {
                lastPostedKeyRef.current = jpushKey;
                console.log("[NativePush] JPush regId registered with server");
              } else {
                console.warn("[NativePush] JPush register failed", await res.text());
              }
            }
          }
        } catch (e) {
          console.warn("[NativePush] JPush register error", e);
        }
      }
    };

    void tryRegister();
    const onRetry = () => void tryRegister();
    window.addEventListener("storage", onRetry);
    window.addEventListener("focus", onRetry);

    return () => {
      cancelled = true;
      fcmActionCleanup?.();
      jpushOpenCleanup?.();
      window.removeEventListener("storage", onRetry);
      window.removeEventListener("focus", onRetry);
    };
  }, [config, navigate]);
}
