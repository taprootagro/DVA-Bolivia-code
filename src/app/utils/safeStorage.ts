// ============================================================
// safeStorage — unified safe localStorage wrapper
// ============================================================
// All localStorage access MUST go through this module.
// On low-end devices / private browsing / disabled storage,
// localStorage may throw. This module swallows errors silently
// (with optional console warnings) and returns safe fallbacks.
//
// Degradation monitoring: tracks failure counts so upstream
// code (errorMonitor / db.ts) can detect storage instability.
// ============================================================

const TAG = '[safeStorage]';

// ---- Degradation tracking ----

interface StorageHealth {
  available: boolean;
  failureCount: number;
  lastFailure: number | null;
  lastFailureOp: string | null;
}

let _health: StorageHealth = {
  available: true,
  failureCount: 0,
  lastFailure: null,
  lastFailureOp: null,
};

// Threshold: after this many consecutive failures we consider storage "degraded"
const DEGRADATION_THRESHOLD = 3;

/** Listeners notified when storage degrades (failure count crosses threshold) */
type DegradationListener = (health: StorageHealth) => void;
const _listeners: DegradationListener[] = [];

function recordFailure(op: string, error?: unknown) {
  _health.available = false;
  _health.failureCount++;
  _health.lastFailure = Date.now();
  _health.lastFailureOp = op;

  if (_health.failureCount === DEGRADATION_THRESHOLD) {
    console.warn(TAG, `Storage degraded after ${DEGRADATION_THRESHOLD} failures (last op: ${op})`);
    for (const fn of _listeners) {
      try { fn({ ..._health }); } catch { /* listener error should not break flow */ }
    }
  }
}

function recordSuccess() {
  // Reset after a successful operation (storage recovered)
  if (!_health.available) {
    console.log(TAG, 'Storage recovered');
  }
  _health.available = true;
  _health.failureCount = 0;
}

/**
 * Subscribe to storage degradation events.
 * The listener fires when failure count crosses the threshold.
 * Returns an unsubscribe function.
 */
export function onStorageDegraded(listener: DegradationListener): () => void {
  _listeners.push(listener);
  return () => {
    const idx = _listeners.indexOf(listener);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/**
 * Check if localStorage is functional right now (probing write + read + delete).
 * The result is cached until the next failure/success.
 */
export function storageAvailable(): boolean {
  try {
    const testKey = '__taproot_probe__';
    localStorage.setItem(testKey, '1');
    const ok = localStorage.getItem(testKey) === '1';
    localStorage.removeItem(testKey);
    if (ok) recordSuccess();
    return ok;
  } catch {
    recordFailure('probe');
    return false;
  }
}

/**
 * Get a snapshot of the current storage health.
 */
export function getStorageHealth(): Readonly<StorageHealth> {
  return { ..._health };
}

// ---- Core API (signatures unchanged) ----

/**
 * Safely read a string value from localStorage.
 * Returns `null` if the key doesn't exist or storage is unavailable.
 */
export function storageGet(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    recordSuccess();
    return v;
  } catch (e) {
    recordFailure(`get("${key}")`, e);
    return null;
  }
}

/**
 * Safely write a string value to localStorage.
 * Returns `true` on success, `false` on failure.
 */
export function storageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    recordSuccess();
    return true;
  } catch (e) {
    console.warn(TAG, `set("${key}") failed:`, e);
    recordFailure(`set("${key}")`, e);
    return false;
  }
}

/**
 * Safely remove a key from localStorage.
 * Returns `true` on success, `false` on failure.
 */
export function storageRemove(key: string): boolean {
  try {
    localStorage.removeItem(key);
    recordSuccess();
    return true;
  } catch (e) {
    console.warn(TAG, `remove("${key}") failed:`, e);
    recordFailure(`remove("${key}")`, e);
    return false;
  }
}

/**
 * Safely read and JSON-parse a value from localStorage.
 * Returns the parsed value, or `fallback` (defaults to `null`) on any error.
 */
export function storageGetJSON<T = unknown>(key: string, fallback: T | null = null): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    recordSuccess();
    return JSON.parse(raw) as T;
  } catch (e) {
    recordFailure(`getJSON("${key}")`, e);
    return fallback;
  }
}

/**
 * Safely JSON-stringify and write a value to localStorage.
 * Returns `true` on success, `false` on failure.
 */
export function storageSetJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    recordSuccess();
    return true;
  } catch (e) {
    console.warn(TAG, `setJSON("${key}") failed:`, e);
    recordFailure(`setJSON("${key}")`, e);
    return false;
  }
}

/**
 * Safely clear all localStorage entries.
 * Returns `true` on success, `false` on failure.
 */
export function storageClear(): boolean {
  try {
    localStorage.clear();
    recordSuccess();
    return true;
  } catch (e) {
    recordFailure('clear', e);
    return false;
  }
}