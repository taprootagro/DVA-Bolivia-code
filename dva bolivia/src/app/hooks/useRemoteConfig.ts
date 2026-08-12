import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  type RolloutConfig,
  type FeatureFlags,
  type AnnouncementConfig,
  type MaintenanceConfig,
  getStoredRemoteConfig,
  getFeatureFlags,
  DEFAULT_FEATURES,
} from '../utils/rollout';
import { storageGet, storageSet } from '../utils/safeStorage';

// ============================================================
// Remote Config Reactive Store
// ============================================================
// Provides a reactive hook for components to read remote config,
// feature flags, announcements, and maintenance status.
//
// Usage:
//   const { features, announcement, maintenance, config } = useRemoteConfig();
//   if (!features.aiAssistant) return <FeatureDisabled />;
// ============================================================

const LS_KEY = 'taproot_remote_config';
const LS_DISMISSED_PREFIX = 'taproot_ann_dismissed_';

// External store for useSyncExternalStore
let _snapshot: RolloutConfig | null = null;
let _listeners: Set<() => void> = new Set();

function _getSnapshot(): RolloutConfig | null {
  return _snapshot;
}

function _subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function _notifyAll() {
  _listeners.forEach((fn) => fn());
}

// Initialize from localStorage
try {
  _snapshot = getStoredRemoteConfig();
} catch { /* ignore */ }

// Listen for localStorage changes (cross-tab + same-tab via custom event)
if (typeof window !== 'undefined') {
  // Cross-tab sync
  window.addEventListener('storage', (e) => {
    if (e.key === LS_KEY) {
      try {
        _snapshot = e.newValue ? JSON.parse(e.newValue) : null;
      } catch {
        _snapshot = null;
      }
      _notifyAll();
    }
  });

  // Same-tab: PWARegister writes to localStorage, we pick it up
  // via a custom event dispatched after config update
  window.addEventListener('taproot-config-updated', () => {
    _snapshot = getStoredRemoteConfig();
    _notifyAll();
  });
}

/**
 * Notify the store that remote config has been updated.
 * Call this after writing to localStorage.
 * Optionally pass the config directly to avoid re-parsing.
 */
export function notifyConfigUpdated(config?: RolloutConfig | null): void {
  _snapshot = config !== undefined ? config : getStoredRemoteConfig();
  _notifyAll();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('taproot-config-updated'));
  }
}

// ============================================================
// Main hook
// ============================================================

export interface UseRemoteConfigResult {
  /** Full remote config object (null if not fetched yet) */
  config: RolloutConfig | null;

  /** Merged feature flags with defaults */
  features: Required<FeatureFlags>;

  /** Check if a specific feature is enabled */
  isEnabled: (feature: keyof FeatureFlags) => boolean;

  /** Announcement config (null if none or disabled) */
  announcement: AnnouncementConfig | null;

  /** Whether the current announcement has been dismissed */
  announcementDismissed: boolean;

  /** Dismiss the current announcement */
  dismissAnnouncement: () => void;

  /** Maintenance mode config (null if not in maintenance) */
  maintenance: MaintenanceConfig | null;

  /** Whether maintenance mode is active */
  isMaintenanceMode: boolean;

  /** Force reload flag from remote */
  forceReload: boolean;

  /** Kill switch flag */
  killSwitch: boolean;
}

export function useRemoteConfig(): UseRemoteConfigResult {
  const config = useSyncExternalStore(_subscribe, _getSnapshot, () => null);

  // Announcement dismiss state
  const annId = config?.announcement?.id || '';
  const [annDismissed, setAnnDismissed] = useState(() => {
    if (!annId) return false;
    return storageGet(LS_DISMISSED_PREFIX + annId) === '1';
  });

  // Re-check dismiss state when announcement ID changes
  useEffect(() => {
    if (!annId) {
      setAnnDismissed(false);
      return;
    }
    setAnnDismissed(storageGet(LS_DISMISSED_PREFIX + annId) === '1');
  }, [annId]);

  const dismissAnnouncement = useCallback(() => {
    if (!annId) return;
    storageSet(LS_DISMISSED_PREFIX + annId, '1');
    setAnnDismissed(true);
  }, [annId]);

  // Feature flags
  const features = getFeatureFlags(config);

  const isEnabled = useCallback(
    (feature: keyof FeatureFlags) => features[feature] !== false,
    [features]
  );

  // Announcement
  const announcement = config?.announcement?.enabled ? config.announcement : null;

  // Maintenance
  const maintenance = config?.maintenance?.enabled ? config.maintenance : null;
  const isMaintenanceMode = !!maintenance;

  return {
    config,
    features,
    isEnabled,
    announcement,
    announcementDismissed: annDismissed,
    dismissAnnouncement,
    maintenance,
    isMaintenanceMode,
    forceReload: !!config?.forceReload,
    killSwitch: !!config?.killSwitch,
  };
}

// ============================================================
// Standalone helpers (for use outside React)
// ============================================================

/**
 * Check a feature flag without React hook.
 */
export function checkFeature(feature: keyof FeatureFlags): boolean {
  const config = getStoredRemoteConfig();
  const flags = getFeatureFlags(config);
  return flags[feature] !== false;
}