import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, X, Download } from 'lucide-react';
import { useLanguage } from '../hooks/useLanguage';
import { shouldShowUpdate, type RolloutConfig } from '../utils/rollout';
import { errorMonitor } from '../utils/errorMonitor';
import { notifyConfigUpdated } from '../hooks/useRemoteConfig';
import { apiClient } from '../utils';
import { storageGet, storageSet, storageGetJSON, storageSetJSON } from '../utils/safeStorage';
import { isNative } from '../utils/capacitor-bridge';

/**
 * PWA Registration & Update Manager
 *
 * Strategy: Cache-first + periodic update check
 *
 * Update flow:
 *   1. SW serves ALL resources from cache first (instant load)
 *   2. Once per day (first open), SW background-checks server for updates
 *   3. If new SW detected, it installs and enters "waiting" state
 *   4. This component shows an update banner at the bottom
 *   5. User taps "Update" → SKIP_WAITING → new SW activates → page reloads
 *
 * To push an update:
 *   1. Bump CACHE_VERSION in /public/service-worker.js
 *   2. Optionally update version in remote config
 *   3. Deploy — clients discover the update on next day's first open
 */

// Remote config
const REMOTE_CONFIG_URL = import.meta.env.VITE_REMOTE_CONFIG_URL || 'https://www.taprootagro.com/taprootagro/globalpublic/customer.json';
const LS_KEY_LAST_REMOTE_CHECK = 'taproot_last_remote_check';
const LS_KEY_REMOTE_CONFIG = 'taproot_remote_config';

/** Check if the current environment supports SW registration */
function canRegisterServiceWorker(): boolean {
  if (import.meta.env.VITE_NATIVE_BUILD === '1') return false;
  if (isNative()) return false;
  if (!('serviceWorker' in navigator)) return false;
  if (window.self !== window.top) return false;
  const hostname = window.location.hostname;
  if (
    hostname.includes('figma.site') ||
    hostname.includes('figma.com') ||
    hostname.includes('codesandbox.io') ||
    hostname.includes('stackblitz.com') ||
    hostname.includes('webcontainer.io')
  ) return false;
  return true;
}

/** Ask waiting SW to fetch fresh index.html + /assets/* before activation */
function requestSwPrecacheUpdate(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data?.ok === true);
      worker.postMessage({ type: 'PRECACHE_UPDATE' }, [channel.port2]);
      setTimeout(() => resolve(false), 15000);
    } catch {
      resolve(false);
    }
  });
}

export function PWARegister() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { t, language } = useLanguage();
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  // ---- Handle update action ----
  const handleUpdate = useCallback(() => {
    if (!waitingWorker) return;

    // iOS Safari PWA: defer update to next cold start to avoid chunk-load errors
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isStandalone = (window.navigator as any).standalone === true ||
                         window.matchMedia('(display-mode: standalone)').matches;

    if (isIOS && isStandalone) {
      sessionStorage.setItem('taproot_sw_pending_update', '1');
      setIsUpdating(true);
      setTimeout(() => {
        alert(t.common.updateOnRestart || 'Update ready! Please close and reopen the app to apply.');
        setIsUpdating(false);
        setDismissed(true);
      }, 500);
      return;
    }

    // Non-iOS: pre-cache new shell, then activate update
    setIsUpdating(true);
    sessionStorage.setItem('taproot_sw_updating', '1');
    void (async () => {
      const precached = await requestSwPrecacheUpdate(waitingWorker);
      if (!precached) {
        console.warn('[PWA] Pre-cache before update failed, continuing with SKIP_WAITING');
      }
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });

      // Safety: force reload if controllerchange doesn't fire within 3s
      setTimeout(() => {
        sessionStorage.removeItem('taproot_sw_updating');
        window.location.reload();
      }, 3000);
    })();
  }, [waitingWorker, t.common.updateOnRestart]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    setTimeout(() => setDismissed(false), 10 * 60 * 1000);
  }, []);

  // ---- Daily remote config check (client-side, complements SW check) ----
  const checkRemoteConfig = useCallback(async (
    registration: ServiceWorkerRegistration | null
  ) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (storageGet(LS_KEY_LAST_REMOTE_CHECK) === today) return;

      const response = await apiClient<RolloutConfig>({
        endpoint: REMOTE_CONFIG_URL,
        method: 'GET',
        preferredVersion: 'v3',
        enableFallback: true,
        cache: true,
        cacheTTL: 24 * 60 * 60 * 1000,
        offlineFallback: true,
        timeout: 10000,
        retry: { maxRetries: 2, initialDelay: 1000 },
        validateResponse: (data: unknown) => typeof data === 'object' && data !== null,
      });

      const config = response.data;

      storageSet(LS_KEY_LAST_REMOTE_CHECK, today);
      storageSetJSON(LS_KEY_REMOTE_CONFIG, config);

      if (config.errorReportUrl) {
        errorMonitor.setReportEndpoint(config.errorReportUrl);
      }

      const remoteVersion = config.version || (config as any).cacheVersion || (config as any).appVersion;
      if (!remoteVersion) return;

      // Get local SW version via MessageChannel
      let localVersion = '';
      if (navigator.serviceWorker.controller) {
        try {
          localVersion = await new Promise<string>((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (e) => resolve(e.data?.version || '');
            navigator.serviceWorker.controller!.postMessage(
              { type: 'GET_VERSION' }, [channel.port2]
            );
            setTimeout(() => resolve(''), 3000);
          });
        } catch {
          localVersion = '';
        }
      }

      if (localVersion && remoteVersion !== localVersion) {
        registration?.update().catch(() => {});
      }

      notifyConfigUpdated(config);
    } catch {
      // Do NOT update timestamp on failure so it retries next load
    }
  }, []);

  useEffect(() => {
    if (!canRegisterServiceWorker()) return;

    let registration: ServiceWorkerRegistration | null = null;

    const trackWaitingWorker = (reg: ServiceWorkerRegistration) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            const config = storageGetJSON<RolloutConfig>(LS_KEY_REMOTE_CONFIG);
            const { shouldUpdate } = shouldShowUpdate(config, '');

            if (shouldUpdate) {
              setWaitingWorker(newWorker);
              setUpdateAvailable(true);
            } else {
              // Re-check rollout eligibility every 30 minutes
              const recheckInterval = setInterval(() => {
                try {
                  const freshConfig = storageGetJSON<RolloutConfig>(LS_KEY_REMOTE_CONFIG);
                  const { shouldUpdate: nowEligible } = shouldShowUpdate(freshConfig, '');
                  if (nowEligible) {
                    setWaitingWorker(newWorker);
                    setUpdateAvailable(true);
                    clearInterval(recheckInterval);
                  }
                } catch { /* ignore */ }
              }, 30 * 60 * 1000);
            }
          }
        });
      });

      // Check if there's already a waiting worker from a previous visit
      if (reg.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(reg.waiting);
        setUpdateAvailable(true);
      }
    };

    const registerSW = async () => {
      try {
        registration = await navigator.serviceWorker.register('/service-worker.js', {
          updateViaCache: 'none',
        });
        regRef.current = registration;
        trackWaitingWorker(registration);
        checkRemoteConfig(registration);
      } catch (error) {
        console.error('[PWA] Service Worker registration failed:', error);
      }
    };

    // Listen for controller change → reload
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      setTimeout(() => {
        sessionStorage.removeItem('taproot_sw_updating');
        window.location.reload();
      }, 300);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    // Listen for SW broadcast messages (remote config actions)
    const onSWMessage = (event: MessageEvent) => {
      const { type } = event.data || {};
      switch (type) {
        case 'FORCE_RELOAD':
        case 'KILL_SWITCH':
          if (!reloading) {
            reloading = true;
            window.location.reload();
          }
          break;
        case 'REMOTE_CONFIG_UPDATED':
          if (event.data.config) {
            storageSetJSON(LS_KEY_REMOTE_CONFIG, event.data.config);
            notifyConfigUpdated(event.data.config);
            if (event.data.config.errorReportUrl) {
              errorMonitor.setReportEndpoint(event.data.config.errorReportUrl);
            }
          }
          break;
      }
    };
    navigator.serviceWorker.addEventListener('message', onSWMessage);

    if (document.readyState === 'complete') {
      registerSW();
    } else {
      window.addEventListener('load', registerSW, { once: true });
    }

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.removeEventListener('message', onSWMessage);
    };
  }, [checkRemoteConfig]);

  // ---- Foreground SW update check ----
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && regRef.current) {
        regRef.current.update();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // ---- Sync language to SW ----
  useEffect(() => {
    if (!canRegisterServiceWorker()) return;
    if (!navigator.serviceWorker.controller) return;

    const langMap: Record<string, string> = {
      en: 'en', zh: 'zh', 'zh-TW': 'zh', es: 'es', fr: 'fr',
      ar: 'ar', pt: 'en', hi: 'en', ru: 'en', bn: 'en',
      ur: 'ar', id: 'en', vi: 'en', ms: 'en', ja: 'zh',
      th: 'en', my: 'en', tl: 'en', tr: 'en', fa: 'ar',
    };

    try {
      navigator.serviceWorker.controller.postMessage({
        type: 'SET_LANGUAGE',
        lang: langMap[language] || 'en',
      });
    } catch { /* SW not ready yet */ }
  }, [language]);

  if (!updateAvailable || dismissed) return null;

  return (
    <div
      className="fixed bottom-16 inset-x-2 z-[9999] animate-slide-up"
      style={{ maxWidth: '420px', margin: '0 auto' }}
    >
      <div
        className="bg-emerald-700 text-white rounded-2xl shadow-2xl overflow-hidden"
        style={{
          boxShadow: '0 -4px 24px rgba(0,0,0,0.2), 0 8px 32px rgba(16,185,129,0.3)',
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex-shrink-0 w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
            <Download className="w-5 h-5" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-white/95" style={{ fontSize: 'clamp(13px, 3.5vw, 14px)' }}>
              {t.common.newVersionAvailable || 'New version available'}
            </p>
            <p className="text-white/60" style={{ fontSize: 'clamp(10px, 2.8vw, 11px)', marginTop: '2px' }}>
              {t.common.tapToUpdate || 'Tap to update for the latest features'}
            </p>
          </div>

          <button
            onClick={handleUpdate}
            disabled={isUpdating}
            className="flex-shrink-0 bg-white text-emerald-700 rounded-xl px-4 py-2 flex items-center gap-1.5 active:scale-95 transition-transform disabled:opacity-70"
            style={{ fontSize: 'clamp(12px, 3.2vw, 13px)' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isUpdating ? 'animate-spin' : ''}`} />
            {isUpdating
              ? (t.common.updating || 'Updating...')
              : (t.common.update || 'Update')
            }
          </button>

          <button
            onClick={handleDismiss}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center text-white/50 hover:text-white/80 rounded-full"
            aria-label={t.common.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isUpdating && (
          <div className="h-0.5 bg-white/20">
            <div className="h-full bg-white/80 animate-progress-bar rounded-full" />
          </div>
        )}
      </div>
    </div>
  );
}
