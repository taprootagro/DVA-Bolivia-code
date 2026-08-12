import { useState, useEffect } from "react";
import { RefreshCw, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { createCmsTranslator } from "../i18n/cmsTranslate";
import enTranslations from "../i18n/lang/en";
import {
  loadSyncQueue as dbLoadSyncQueue,
  saveSyncQueue as dbSaveSyncQueue,
  addToSyncQueue as dbAddToSyncQueue,
  type SyncQueueRecord,
} from "../utils/db";
import { storageGetJSON } from "../utils/safeStorage";

/**
 * Background Sync Manager
 *
 * - Offline data queue management
 * - Auto-sync on network recovery
 * - Sync status display with i18n
 * - Manual sync trigger
 */

interface SyncItem {
  id: string;
  type: "comment" | "like" | "purchase" | "post" | "other";
  data: any;
  timestamp: number;
  status: "pending" | "syncing" | "success" | "failed";
  retryCount: number;
}

export function BackgroundSync() {
  const { t, language } = useLanguage();
  const ct = createCmsTranslator(t, language, enTranslations);

  const [isSupported, setIsSupported] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncQueue, setSyncQueue] = useState<SyncItem[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  // Check browser support
  useEffect(() => {
    setIsSupported(
      "serviceWorker" in navigator &&
        "sync" in ServiceWorkerRegistration.prototype
    );
  }, []);

  // Listen for network status changes
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      triggerBackgroundSync();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Load sync queue from DB
  useEffect(() => {
    loadSyncQueue();
    const interval = setInterval(loadSyncQueue, 3000);
    return () => clearInterval(interval);
  }, []);

  const loadSyncQueue = () => {
    dbLoadSyncQueue()
      .then((records) => {
        const queue: SyncItem[] = records.map((r) => ({
          id: r.id,
          type: r.type as SyncItem["type"],
          data:
            typeof r.data === "string"
              ? (() => {
                  try {
                    return JSON.parse(r.data);
                  } catch {
                    return r.data;
                  }
                })()
              : r.data,
          timestamp: r.timestamp,
          status: r.status as SyncItem["status"],
          retryCount: r.retryCount,
        }));
        setSyncQueue(queue);
      })
      .catch(() => {
        const stored = storageGetJSON<SyncItem[]>("taproot-sync-queue");
        if (stored) setSyncQueue(stored);
      });
  };

  const saveSyncQueue = (queue: SyncItem[]) => {
    setSyncQueue(queue);
    const records: SyncQueueRecord[] = queue.map((item) => ({
      id: item.id,
      type: item.type,
      data: JSON.stringify(item.data),
      timestamp: item.timestamp,
      status: item.status,
      retryCount: item.retryCount,
    }));
    dbSaveSyncQueue(records).catch(() => {});
  };

  const triggerBackgroundSync = async () => {
    if (!isSupported) {
      await manualSync();
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.sync.register("sync-data");
      await manualSync();
    } catch {
      await manualSync();
    }
  };

  const manualSync = async () => {
    if (isSyncing || !isOnline) return;
    const pendingItems = syncQueue.filter(
      (item) => item.status === "pending" || item.status === "failed"
    );
    if (pendingItems.length === 0) return;

    setIsSyncing(true);
    try {
      for (const item of pendingItems) {
        try {
          updateItemStatus(item.id, "syncing");
          await syncToBackend(item);
          updateItemStatus(item.id, "success");
        } catch {
          const retryCount = item.retryCount + 1;
          if (retryCount >= 3) {
            updateItemStatus(item.id, "failed");
          } else {
            updateItemRetry(item.id, retryCount);
          }
        }
      }
      setLastSyncTime(new Date());
      setTimeout(cleanupSuccessItems, 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  const syncToBackend = async (item: SyncItem) => {
    const endpoints: Record<SyncItem["type"], string> = {
      comment: "/api/comments",
      like: "/api/likes",
      purchase: "/api/purchases",
      post: "/api/posts",
      other: "/api/sync",
    };
    const response = await fetch(endpoints[item.type], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.data),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  };

  const updateItemStatus = (id: string, status: SyncItem["status"]) => {
    const newQueue = syncQueue.map((item) =>
      item.id === id ? { ...item, status } : item
    );
    saveSyncQueue(newQueue);
  };

  const updateItemRetry = (id: string, retryCount: number) => {
    const newQueue = syncQueue.map((item) =>
      item.id === id
        ? { ...item, retryCount, status: "pending" as const }
        : item
    );
    saveSyncQueue(newQueue);
  };

  const cleanupSuccessItems = () => {
    const successItems = syncQueue.filter((item) => item.status === "success");
    if (successItems.length > 10) {
      const toKeepIds = new Set(
        successItems
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 10)
          .map((i) => i.id)
      );
      saveSyncQueue(
        syncQueue.filter(
          (item) => item.status !== "success" || toKeepIds.has(item.id)
        )
      );
    }
  };

  const clearCompleted = () => {
    saveSyncQueue(syncQueue.filter((item) => item.status !== "success"));
  };

  const retryFailed = () => {
    saveSyncQueue(
      syncQueue.map((item) =>
        item.status === "failed"
          ? { ...item, status: "pending" as const, retryCount: 0 }
          : item
      )
    );
    triggerBackgroundSync();
  };

  const stats = {
    pending: syncQueue.filter((item) => item.status === "pending").length,
    syncing: syncQueue.filter((item) => item.status === "syncing").length,
    success: syncQueue.filter((item) => item.status === "success").length,
    failed: syncQueue.filter((item) => item.status === "failed").length,
  };

  if (!isSupported) {
    return (
      <div
        className="bg-yellow-50 rounded-lg"
        style={{ padding: "clamp(12px, 3vw, 16px)" }}
      >
        <div
          className="flex items-start"
          style={{ gap: "clamp(8px, 2vw, 12px)" }}
        >
          <AlertCircle
            className="text-yellow-600 flex-shrink-0"
            style={{ width: "20px", height: "20px" }}
          />
          <div>
            <p
              className="text-yellow-800 font-medium"
              style={{ fontSize: "clamp(12px, 3.2vw, 14px)" }}
            >
              {ct("messages.background_sync_unavailable", "后台同步不可用", "Background sync unavailable")}
            </p>
            <p
              className="text-yellow-700"
              style={{
                fontSize: "clamp(10px, 2.8vw, 12px)",
                marginTop: "4px",
              }}
            >
              {ct("messages.your_browser_does_not_support_background_sync_data", "当前浏览器不支持后台同步，数据将立即发送", "Your browser does not support background sync. Data will be sent immediately.")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Network status */}
      <div
        className={`rounded-lg ${isOnline ? "bg-emerald-50" : "bg-amber-50"}`}
        style={{ padding: "clamp(12px, 3vw, 16px)" }}
      >
        <div className="flex items-center justify-between">
          <div
            className="flex items-center"
            style={{ gap: "clamp(8px, 2vw, 12px)" }}
          >
            <div
              className={`w-3 h-3 rounded-full ${isOnline ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <div>
              <p
                className={`font-medium ${isOnline ? "text-emerald-900" : "text-amber-900"}`}
                style={{ fontSize: "clamp(12px, 3.2vw, 14px)" }}
              >
                {isOnline
                  ? ct("messages.online", "网络正常", "Online")
                  : ct("messages.offline", "离线模式", "Offline")}
              </p>
              <p
                className={isOnline ? "text-emerald-700" : "text-amber-700"}
                style={{
                  fontSize: "clamp(10px, 2.8vw, 12px)",
                  marginTop: "2px",
                }}
              >
                {isOnline
                  ? ct("messages.data_syncing_in_real_time", "数据实时同步中", "Data syncing in real time")
                  : ct("messages.data_will_sync_automatically_when_back_online", "数据将在网络恢复后自动同步", "Data will sync automatically when back online")}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Sync stats */}
      <div className="grid grid-cols-4 gap-2">
        {[
          {
            icon: Clock,
            value: stats.pending,
            label: ct("messages.pending", "待同步", "Pending"),
            color: "gray",
          },
          {
            icon: RefreshCw,
            value: stats.syncing,
            label: ct("messages.syncing", "同步中", "Syncing"),
            color: "blue",
          },
          {
            icon: CheckCircle,
            value: stats.success,
            label: ct("messages.done", "已完成", "Done"),
            color: "emerald",
          },
          {
            icon: AlertCircle,
            value: stats.failed,
            label: ct("messages.failed_1", "失败", "Failed"),
            color: "red",
          },
        ].map(({ icon: Icon, value, label, color }) => (
          <div
            key={label}
            className={`bg-${color}-50 rounded-lg text-center`}
            style={{ padding: "clamp(8px, 2vw, 10px)" }}
          >
            <Icon
              className={`text-${color}-500 mx-auto mb-1`}
              style={{ width: "16px", height: "16px" }}
            />
            <p
              className={`text-${color}-900 font-bold`}
              style={{ fontSize: "clamp(14px, 4vw, 18px)" }}
            >
              {value}
            </p>
            <p
              className={`text-${color}-700`}
              style={{ fontSize: "clamp(9px, 2.5vw, 10px)" }}
            >
              {label}
            </p>
          </div>
        ))}
      </div>

      {/* Last sync time */}
      {lastSyncTime && (
        <div
          className="text-center text-gray-600"
          style={{ fontSize: "clamp(10px, 2.8vw, 11px)" }}
        >
          {ct("messages.last_sync", "最后同步", "Last sync")}: {lastSyncTime.toLocaleTimeString()}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex" style={{ gap: "clamp(8px, 2vw, 12px)" }}>
        <button
          onClick={manualSync}
          disabled={isSyncing || !isOnline || stats.pending === 0}
          className="flex-1 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium flex items-center justify-center"
          style={{
            padding: "clamp(10px, 2.5vw, 12px)",
            fontSize: "clamp(12px, 3.2vw, 14px)",
            gap: "clamp(6px, 1.5vw, 8px)",
          }}
        >
          <RefreshCw
            style={{ width: "16px", height: "16px" }}
            className={isSyncing ? "animate-spin" : ""}
          />
          {isSyncing
            ? ct("messages.syncing_1", "同步中...", "Syncing...")
            : ct("messages.sync_now", "立即同步", "Sync now")}
        </button>

        {stats.failed > 0 && (
          <button
            onClick={retryFailed}
            disabled={isSyncing || !isOnline}
            className="flex-1 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
            style={{
              padding: "clamp(10px, 2.5vw, 12px)",
              fontSize: "clamp(12px, 3.2vw, 14px)",
            }}
          >
            {ct("messages.retry_failed", "重试失败", "Retry failed")}
          </button>
        )}

        {stats.success > 0 && (
          <button
            onClick={clearCompleted}
            className="bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors font-medium"
            style={{
              padding: "clamp(10px, 2.5vw, 12px)",
              fontSize: "clamp(12px, 3.2vw, 14px)",
              minWidth: "80px",
            }}
          >
            {ct("messages.clear", "清除", "Clear")}
          </button>
        )}
      </div>

      {/* Hint */}
      <div
        className="bg-blue-50 rounded-lg"
        style={{ padding: "clamp(10px, 2.5vw, 12px)" }}
      >
        <p
          className="text-blue-700"
          style={{
            fontSize: "clamp(10px, 2.8vw, 11px)",
            lineHeight: "1.5",
          }}
        >
          {ct("messages.when_offline_your_actions_are_saved_locally_and", "网络断开时，您的操作会自动保存，并在网络恢复后自动同步。", "When offline, your actions are saved locally and will sync automatically once the network is restored.")}
        </p>
      </div>
    </div>
  );
}

// Utility for other components to enqueue sync items
export const queueForSync = (type: SyncItem["type"], data: any) => {
  const newItem: SyncQueueRecord = {
    id: `${Date.now()}-${Math.random()}`,
    type,
    data: JSON.stringify(data),
    timestamp: Date.now(),
    status: "pending",
    retryCount: 0,
  };

  dbAddToSyncQueue(newItem).catch(() => {});

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((registration) => {
      registration.sync.register("sync-data").catch(() => {});
    });
  }
};
