// ============================================================
// Remote Config & Gradual Rollout System
// ============================================================
// Determines if the current device is in the rollout group
// based on a stable device ID and the rollout percentage
// from the remote config.
//
// How it works:
// 1. Each device gets a stable random ID (persisted in localStorage)
// 2. The ID is hashed to a number between 0-99
// 3. If that number < rolloutPercentage, the device is in the group
//
// ============================================================
// REMOTE CONFIG JSON SCHEMA
// ============================================================
// Deploy this JSON at your REMOTE_CONFIG_URL endpoint.
// All fields are optional — omitted fields use safe defaults.
//
// {
//   // ---- Version & Update Control ----
//   "version": "v9",                // Current deployed SW version
//   "forceUpdate": false,           // Force all users to update immediately (bypass rollout)
//   "forceReload": false,           // Force all clients to reload on next config check
//   "rolloutPercentage": 100,       // 0-100, gradual rollout percentage
//   "rolloutMinVersion": "v7",      // Only apply rollout to devices on this version+
//
//   // ---- Cache Control ----
//   "purgeCache": false,            // Purge ALL caches on next visit (one-shot, reset to false after)
//   "purgeImageCache": false,       // Purge image cache only
//   "cacheStrategy": {              // Override cache strategies per path pattern
//     "networkFirst": ["/api/prices"],   // Paths that should use network-first
//     "networkOnly": ["/api/auth"],      // Paths that should bypass cache entirely
//     "noCache": ["/debug"]              // Paths excluded from caching
//   },
//   "maxCacheEntries": 200,         // Override max same-origin cache entries
//   "maxImageCacheEntries": 300,    // Override max image cache entries
//   "networkTimeoutMs": 20000,      // Override network timeout for cache-first strategy
//   "navTimeoutMs": {               // Override navigation timeouts
//     "withCache": 8000,            // Timeout when cached index.html exists (fallback to cache)
//     "withoutCache": 15000         // Timeout when no cache (wait for network)
//   },
//
//   // ---- Maintenance Mode ----
//   "maintenance": {
//     "enabled": false,
//     "title": "System Maintenance",
//     "message": "We're upgrading our systems. Please check back soon.",
//     "estimatedEnd": "2026-03-02T14:00:00Z",  // ISO 8601
//     "allowPaths": ["/sw-reset"]               // Paths that bypass maintenance
//   },
//
//   // ---- Feature Flags ----
//   "features": {
//     "aiAssistant": true,
//     "aiCloud": true,
//     "aiLocal": true,
//     "community": true,
//     "market": true,
//     "weather": true,
//     "push": true,
//     "scanner": true
//   },
//
//   // ---- Announcement Banner ----
//   "announcement": {
//     "enabled": false,
//     "id": "ann-001",               // Unique ID (dismissed state keyed on this)
//     "message": "Welcome to v9!",
//     "type": "info",                // "info" | "warning" | "critical"
//     "dismissable": true,
//     "actionUrl": "",               // Optional CTA link
//     "actionLabel": "Learn more"
//   },
//
//   // ---- Error Reporting ----
//   "errorReportUrl": "https://your-endpoint.com/errors",
//
//   // ---- Check Interval ----
//   "checkIntervalHours": 24,       // Override daily check frequency (min 1, max 168)
//
//   // ---- Kill Switch ----
//   "killSwitch": false             // Nuclear option: unregister SW + clear all caches
// }
// ============================================================

import { getStableDeviceId } from './errorMonitor';
import { storageGet } from './safeStorage';

const LS_KEY_REMOTE_CONFIG = 'taproot_remote_config';

/**
 * Hash a string to a number between 0-99.
 * Simple but deterministic — same input always gives same output.
 */
function hashToPercent(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100;
}

/**
 * Get the device's rollout bucket (0-99).
 * This is deterministic — same device always gets the same bucket.
 */
export function getDeviceRolloutBucket(): number {
  const deviceId = getStableDeviceId();
  return hashToPercent(deviceId);
}

/**
 * Check if the current device is in the rollout group.
 */
export function isInRolloutGroup(rolloutPercentage: number): boolean {
  if (rolloutPercentage >= 100) return true;
  if (rolloutPercentage <= 0) return false;

  const bucket = getDeviceRolloutBucket();
  return bucket < rolloutPercentage;
}

// ============================================================
// Type definitions for remote config
// ============================================================

export interface CacheStrategyOverride {
  networkFirst?: string[];   // URL path patterns → network-first strategy
  networkOnly?: string[];    // URL path patterns → bypass cache entirely
  noCache?: string[];        // URL path patterns → never cache responses
}

export interface NavTimeoutOverride {
  withCache?: number;        // ms, timeout when cached HTML exists
  withoutCache?: number;     // ms, timeout when no cache
}

export interface MaintenanceConfig {
  enabled: boolean;
  title?: string;
  message?: string;
  estimatedEnd?: string;     // ISO 8601 datetime
  allowPaths?: string[];     // Paths that bypass maintenance mode
}

export interface FeatureFlags {
  aiAssistant?: boolean;
  aiCloud?: boolean;
  aiLocal?: boolean;
  community?: boolean;
  market?: boolean;
  weather?: boolean;
  push?: boolean;
  scanner?: boolean;
  [key: string]: boolean | undefined;  // Allow custom flags
}

export interface AnnouncementConfig {
  enabled: boolean;
  id?: string;               // Unique ID for dismiss tracking
  message: string;
  type?: 'info' | 'warning' | 'critical';
  dismissable?: boolean;
  actionUrl?: string;
  actionLabel?: string;
}

export interface RolloutConfig {
  // Version & Update
  version?: string;
  forceUpdate?: boolean;
  forceReload?: boolean;
  rolloutPercentage?: number;
  rolloutMinVersion?: string;

  // Cache Control
  purgeCache?: boolean;
  purgeImageCache?: boolean;
  cacheStrategy?: CacheStrategyOverride;
  maxCacheEntries?: number;
  maxImageCacheEntries?: number;
  networkTimeoutMs?: number;
  navTimeoutMs?: NavTimeoutOverride;

  // Maintenance
  maintenance?: MaintenanceConfig;

  // Feature Flags
  features?: FeatureFlags;

  // Announcement
  announcement?: AnnouncementConfig;

  // Error Reporting
  errorReportUrl?: string;

  // Check Interval
  checkIntervalHours?: number;

  // Kill Switch
  killSwitch?: boolean;
}

// ============================================================
// Config access helpers
// ============================================================

/**
 * Get the stored remote config from safeStorage.
 */
export function getStoredRemoteConfig(): RolloutConfig | null {
  try {
    const raw = storageGet(LS_KEY_REMOTE_CONFIG);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Default feature flags — all features enabled.
 */
export const DEFAULT_FEATURES: Required<FeatureFlags> = {
  aiAssistant: true,
  aiCloud: true,
  aiLocal: true,
  community: true,
  market: true,
  weather: true,
  push: true,
  scanner: true,
};

/**
 * Get merged feature flags (remote config overrides defaults).
 */
export function getFeatureFlags(config?: RolloutConfig | null): Required<FeatureFlags> {
  if (!config) config = getStoredRemoteConfig();
  return { ...DEFAULT_FEATURES, ...(config?.features || {}) };
}

/**
 * Check if a specific feature is enabled.
 */
export function isFeatureEnabled(feature: keyof FeatureFlags, config?: RolloutConfig | null): boolean {
  const flags = getFeatureFlags(config);
  return flags[feature] !== false;
}

/**
 * Determine if an update should be shown to this device.
 */
export function shouldShowUpdate(
  config: RolloutConfig | null,
  currentVersion: string
): { shouldUpdate: boolean; reason: string } {
  if (!config) {
    config = getStoredRemoteConfig();
  }

  if (!config || !config.version) {
    return { shouldUpdate: true, reason: 'No remote config, default to show update' };
  }

  // Version match — no update needed
  if (config.version === currentVersion) {
    return { shouldUpdate: false, reason: 'Already on latest version' };
  }

  // Force update — bypass rollout
  if (config.forceUpdate) {
    return { shouldUpdate: true, reason: 'Force update enabled' };
  }

  // Rollout percentage check
  const rolloutPct = config.rolloutPercentage ?? 100;
  const inGroup = isInRolloutGroup(rolloutPct);
  const bucket = getDeviceRolloutBucket();

  if (inGroup) {
    return {
      shouldUpdate: true,
      reason: `In rollout group (bucket ${bucket}, rollout ${rolloutPct}%)`,
    };
  }

  return {
    shouldUpdate: false,
    reason: `Not in rollout group (bucket ${bucket}, rollout ${rolloutPct}%)`,
  };
}