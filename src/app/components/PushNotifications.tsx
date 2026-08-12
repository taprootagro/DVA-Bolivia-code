import { useState, useEffect, useCallback, useMemo } from "react";
import { Bell, BellOff, Check, X, AlertTriangle } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import { getSessionAccessTokenForEdge, TAPROOT_AUTH_CHANGE_EVENT } from "../utils/auth";

/**
 * Push Notifications Component
 * 
 * Features:
 * 1. Request push permission
 * 2. Subscribe to push service (using VAPID key from config or multi-provider config)
 * 3. Show notification status
 * 4. Unsubscribe
 * 5. Graceful degradation when backend is not configured
 * 6. Multi-provider support: Web Push / FCM / OneSignal / JPush / GeTui
 */

interface PushNotificationsProps {
  onSubscriptionChange?: (subscription: PushSubscription | null) => void;
}

export function PushNotifications({ onSubscriptionChange }: PushNotificationsProps) {
  const { t, language } = useLanguage();
  const { config } = useConfigContext();
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [isSupported, setIsSupported] = useState(true);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);

  const pushT = t.pushNotifications;
  const pushConfig = config.pushConfig;
  const ppc = config.pushProvidersConfig;
  const bp = (config as { backendProxyConfig?: { supabaseUrl?: string; supabaseAnonKey?: string; edgeFunctionName?: string } }).backendProxyConfig;

  const effectiveVapidPublicKey = useMemo(() => {
    const candidates = [ppc?.webpush?.vapidPublicKey, pushConfig.vapidPublicKey];
    for (const raw of candidates) {
      const key = normalizeVapidPublicKey(raw);
      if (key && key !== "YOUR_VAPID_PUBLIC_KEY" && key.length > 20 && isValidVapidPublicKey(key)) {
        return key;
      }
    }
    return "";
  }, [ppc?.webpush?.vapidPublicKey, pushConfig.vapidPublicKey]);

  const effectivePushApiBase = useMemo(() => {
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

    const fromWebpush = normalizePushApiBase(ppc?.webpush?.pushApiBase || "");
    if (fromWebpush) return fromWebpush;
    const fromPushConfig = normalizePushApiBase(pushConfig.pushApiBase || "");
    if (fromPushConfig) return fromPushConfig;
    return derivedFromSupabase();
  }, [ppc?.webpush?.pushApiBase, pushConfig.pushApiBase, bp?.supabaseUrl, bp?.edgeFunctionName]);

  // Check if backend is configured (not placeholder values)
  const isBackendConfigured = useCallback(() => {
    return (
      effectiveVapidPublicKey !== "YOUR_VAPID_PUBLIC_KEY" &&
      effectiveVapidPublicKey.length > 20 &&
      effectivePushApiBase.length > 0
    );
  }, [effectiveVapidPublicKey, effectivePushApiBase]);

  const sendSubscriptionToBackend = useCallback(
    async (sub: PushSubscription) => {
      if (!isBackendConfigured()) {
        setBackendAvailable(false);
        return;
      }

      const token = await getSessionAccessTokenForEdge();
      if (!token) {
        console.warn("[Push] No access token — log in to register push subscription");
        setBackendAvailable(false);
        return;
      }

      const anon = (bp?.supabaseAnonKey || "").trim();
      const bodyJson = { ...serializePushSubscription(sub), language };

      try {
        const response = await fetch(`${effectivePushApiBase}/push/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...(anon ? { apikey: anon } : {}),
          },
          body: JSON.stringify(bodyJson),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status} ${errText}`);
        }

        setBackendAvailable(true);
        console.log("[Push] Subscription saved to backend");
      } catch (err) {
        console.error("[Push] Failed to save subscription to backend:", err);
        setBackendAvailable(false);
      }
    },
    [isBackendConfigured, effectivePushApiBase, bp?.supabaseAnonKey, language],
  );

  const subscribeToPush = useCallback(async () => {
    const registration = await navigator.serviceWorker.ready;

    if (!effectiveVapidPublicKey || !isValidVapidPublicKey(effectiveVapidPublicKey)) {
      throw new Error("Invalid VAPID public key in config");
    }

    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
    }

    const convertedVapidKey = urlBase64ToUint8Array(effectiveVapidPublicKey);

    const pushSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey,
    });

    setSubscription(pushSubscription);
    onSubscriptionChange?.(pushSubscription);
    await sendSubscriptionToBackend(pushSubscription);
    console.log("[Push] Subscription successful");
  }, [effectiveVapidPublicKey, onSubscriptionChange, sendSubscriptionToBackend]);

  const checkExistingSubscription = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const existingSubscription = await registration.pushManager.getSubscription();

      if (existingSubscription) {
        setSubscription(existingSubscription);
        onSubscriptionChange?.(existingSubscription);
        await sendSubscriptionToBackend(existingSubscription);
      }
    } catch (err) {
      console.error("[Push] Failed to check subscription:", err);
    }
  }, [onSubscriptionChange, sendSubscriptionToBackend]);

  /** Request permission (if needed) and subscribe — also used to re-enable after unsubscribe. */
  const enablePush = useCallback(async () => {
    if (permission === "denied") return;

    setLoading(true);
    setError("");

    try {
      let nextPermission = permission;
      if (nextPermission !== "granted") {
        nextPermission = await Notification.requestPermission();
        setPermission(nextPermission);
      }

      if (nextPermission !== "granted") {
        if (nextPermission === "denied") setError(pushT.permissionDenied);
        return;
      }

      if (!isBackendConfigured()) {
        setBackendAvailable(false);
        return;
      }

      await subscribeToPush();
    } catch (err) {
      console.error("[Push] Enable failed:", err);
      setError(pushT.subscribeFailed);
    } finally {
      setLoading(false);
    }
  }, [
    permission,
    isBackendConfigured,
    subscribeToPush,
    pushT.permissionDenied,
    pushT.subscribeFailed,
  ]);

  // Check browser support and sync any existing subscription
  useEffect(() => {
    const supported =
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window;

    setIsSupported(supported);

    if (supported) {
      setPermission(Notification.permission);
      void checkExistingSubscription();
    }
  }, [checkExistingSubscription]);

  // Re-sync local subscription after login / logout
  useEffect(() => {
    const onAuthChange = () => {
      void checkExistingSubscription();
    };
    window.addEventListener(TAPROOT_AUTH_CHANGE_EVENT, onAuthChange);
    return () => window.removeEventListener(TAPROOT_AUTH_CHANGE_EVENT, onAuthChange);
  }, [checkExistingSubscription]);

  // Unsubscribe
  const unsubscribe = async () => {
    if (!subscription) return;

    setLoading(true);
    setError("");

    try {
      await subscription.unsubscribe();
      setSubscription(null);
      setBackendAvailable(null);
      onSubscriptionChange?.(null);

      // Notify backend to remove subscription
      if (isBackendConfigured()) {
        await removeSubscriptionFromBackend(subscription);
      }

      console.log("[Push] Unsubscribed successfully");
    } catch (err) {
      console.error("[Push] Unsubscribe failed:", err);
      setError(pushT.unsubscribeFailed);
    } finally {
      setLoading(false);
    }
  };

  // Remove subscription from backend
  const removeSubscriptionFromBackend = async (sub: PushSubscription) => {
    if (!isBackendConfigured()) return;
    const token = await getSessionAccessTokenForEdge();
    if (!token) return;
    const anon = (bp?.supabaseAnonKey || "").trim();
    const endpoint = sub.endpoint;

    try {
      const response = await fetch(`${effectivePushApiBase}/push/unsubscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(anon ? { apikey: anon } : {}),
        },
        body: JSON.stringify({ endpoint }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log("[Push] Subscription removed from backend");
    } catch (err) {
      console.error("[Push] Failed to remove subscription from backend:", err);
    }
  };

  // Test local notification
  const testNotification = () => {
    if (permission !== "granted") {
      setError(pushT.needPermission);
      return;
    }

    new Notification(pushT.testTitle, {
      body: pushT.testBody,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "test-notification",
      vibrate: [200, 100, 200],
    });
  };

  // Browser not supported
  if (!isSupported) {
    return (
      <div className="bg-yellow-50 rounded-lg" style={{ padding: "clamp(12px, 3vw, 16px)" }}>
        <div className="flex items-start" style={{ gap: "clamp(8px, 2vw, 12px)" }}>
          <BellOff className="text-yellow-600 flex-shrink-0" style={{ width: "20px", height: "20px" }} />
          <div>
            <p className="text-yellow-800" style={{ fontSize: "clamp(12px, 3.2vw, 14px)" }}>
              {pushT.notSupported}
            </p>
            <p className="text-yellow-700" style={{ fontSize: "clamp(10px, 2.8vw, 12px)", marginTop: "4px" }}>
              {pushT.notSupportedDesc}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Status display */}
      <div className="bg-gray-50 rounded-lg" style={{ padding: "clamp(12px, 3vw, 16px)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center" style={{ gap: "clamp(8px, 2vw, 12px)" }}>
            {subscription ? (
              <Bell className="text-emerald-600" style={{ width: "20px", height: "20px" }} />
            ) : (
              <BellOff className="text-gray-400" style={{ width: "20px", height: "20px" }} />
            )}
            <div>
              <p className="text-gray-900" style={{ fontSize: "clamp(12px, 3.2vw, 14px)" }}>
                {pushT.title}
              </p>
              <p className="text-gray-600" style={{ fontSize: "clamp(10px, 2.8vw, 12px)", marginTop: "2px" }}>
                {subscription
                  ? pushT.enabled
                  : permission === "denied"
                    ? pushT.denied
                    : pushT.disabled}
              </p>
            </div>
          </div>

          {/* Status icon */}
          {subscription && (
            <div className="bg-emerald-100 rounded-full" style={{ padding: "4px" }}>
              <Check className="text-emerald-600" style={{ width: "16px", height: "16px" }} />
            </div>
          )}
          {permission === "denied" && (
            <div className="bg-red-100 rounded-full" style={{ padding: "4px" }}>
              <X className="text-red-600" style={{ width: "16px", height: "16px" }} />
            </div>
          )}
        </div>
      </div>

      {/* Backend not configured warning */}
      {backendAvailable === false && (
        <div className="bg-amber-50 rounded-lg" style={{ padding: "clamp(10px, 2.5vw, 12px)" }}>
          <div className="flex items-start" style={{ gap: "clamp(6px, 1.5vw, 8px)" }}>
            <AlertTriangle className="text-amber-600 flex-shrink-0 mt-0.5" style={{ width: "14px", height: "14px" }} />
            <p className="text-amber-700" style={{ fontSize: "clamp(10px, 2.8vw, 11px)", lineHeight: "1.5" }}>
              {pushT.noBackendNote}
            </p>
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="bg-red-50 rounded-lg" style={{ padding: "clamp(10px, 2.5vw, 12px)" }}>
          <p className="text-red-600" style={{ fontSize: "clamp(10px, 2.8vw, 12px)" }}>
            {error}
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex" style={{ gap: "clamp(8px, 2vw, 12px)" }}>
        {!subscription ? (
          <button
            onClick={enablePush}
            disabled={loading || permission === "denied"}
            className="flex-1 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            style={{
              padding: "clamp(10px, 2.5vw, 12px)",
              fontSize: "clamp(12px, 3.2vw, 14px)",
            }}
          >
            {loading ? pushT.enabling : pushT.enableButton}
          </button>
        ) : (
          <>
            <button
              onClick={testNotification}
              className="flex-1 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
              style={{
                padding: "clamp(10px, 2.5vw, 12px)",
                fontSize: "clamp(12px, 3.2vw, 14px)",
              }}
            >
              {pushT.testButton}
            </button>
            <button
              onClick={unsubscribe}
              disabled={loading}
              className="flex-1 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
              style={{
                padding: "clamp(10px, 2.5vw, 12px)",
                fontSize: "clamp(12px, 3.2vw, 14px)",
              }}
            >
              {loading ? pushT.disabling : pushT.disableButton}
            </button>
          </>
        )}
      </div>

      {/* Tip text */}
      <div className="bg-blue-50 rounded-lg" style={{ padding: "clamp(10px, 2.5vw, 12px)" }}>
        <p className="text-blue-700" style={{ fontSize: "clamp(10px, 2.8vw, 11px)", lineHeight: "1.5" }}>
          {pushT.tip}
        </p>
      </div>
    </div>
  );
}

function serializePushSubscription(sub: PushSubscription): Record<string, unknown> {
  const withJson = sub as unknown as { toJSON?: () => Record<string, unknown> };
  if (typeof withJson.toJSON === "function") {
    return withJson.toJSON();
  }
  const p256dh = sub.getKey("p256dh");
  const auth = sub.getKey("auth");
  if (!p256dh || !auth) {
    throw new Error("Missing push subscription keys");
  }
  return {
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime,
    keys: {
      p256dh: arrayBufferToBase64Url(p256dh),
      auth: arrayBufferToBase64Url(auth),
    },
  };
}

function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Utility: Convert base64 string to Uint8Array
function normalizeVapidPublicKey(raw: string | undefined): string {
  return (raw || "").replace(/\s+/g, "").trim();
}

function isValidVapidPublicKey(key: string): boolean {
  try {
    const bytes = urlBase64ToUint8Array(key);
    return bytes.byteLength >= 65;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}