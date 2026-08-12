// ============================================================================
// CloudAIGuard - Frontend Anti-Abuse Protection Layer
// ============================================================================
// Implements client-side protections to reduce unnecessary cloud AI calls:
//   1. Image compression (resize + quality reduction before upload)
//   2. Cooldown timer (minimum interval between requests)
//   3. Daily usage quota (localStorage-tracked per-day limit)
//   4. Image hash dedup (don't send identical images twice)
//
// NOTE: These are "polite" frontend guards — real security MUST be enforced
// server-side in the Supabase Edge Function. These reduce honest misuse,
// accidental spam, and save bandwidth/costs.
// ============================================================================

import { storageGet, storageSet, storageRemove } from './safeStorage';
import {
  AI_VISION_IMAGE_LIMITS,
  compressImageBase64,
  estimateDataUrlBytes,
} from './imageCompressor';

const GUARD_STORAGE_KEY = 'agri_cloud_ai_guard';
const CACHE_STORAGE_KEY = 'agri_cloud_ai_cache';

// ---------- Configuration ----------

export interface GuardConfig {
  /** Max image dimension (longest side) before compression */
  maxImageSize: number;
  /** WebP/JPEG quality for compressed output (0-1) */
  imageQuality: number;
  /** Max compressed image bytes (approx.) */
  maxImageBytes: number;
  /** Cooldown between requests in seconds, default 15 */
  cooldownSeconds: number;
  /** Maximum cloud AI calls per day, default 20 */
  dailyLimit: number;
  /** Enable image hash dedup caching, default true */
  enableDedup: boolean;
  /** Max cached results to keep, default 50 */
  maxCacheEntries: number;
}

const DEFAULT_GUARD_CONFIG: GuardConfig = {
  maxImageSize: AI_VISION_IMAGE_LIMITS.maxSize,
  imageQuality: AI_VISION_IMAGE_LIMITS.quality,
  maxImageBytes: AI_VISION_IMAGE_LIMITS.maxBytes,
  cooldownSeconds: 20,
  dailyLimit: 15,
  enableDedup: true,
  maxCacheEntries: 50,
};

// ---------- Usage Tracking ----------

interface UsageRecord {
  date: string;       // YYYY-MM-DD
  count: number;
  lastCallTimestamp: number;
}

function getTodayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getUsage(): UsageRecord {
  try {
    const raw = storageGet(GUARD_STORAGE_KEY);
    if (raw) {
      const record: UsageRecord = JSON.parse(raw);
      // Reset if it's a new day
      if (record.date !== getTodayStr()) {
        return { date: getTodayStr(), count: 0, lastCallTimestamp: 0 };
      }
      return record;
    }
  } catch { /* ignore */ }
  return { date: getTodayStr(), count: 0, lastCallTimestamp: 0 };
}

function saveUsage(record: UsageRecord): void {
  try {
    storageSet(GUARD_STORAGE_KEY, JSON.stringify(record));
  } catch { /* ignore */ }
}

// ---------- Image Hash (fast simple hash for dedup) ----------

async function hashImageBase64(base64: string): Promise<string> {
  // Use SubtleCrypto if available, else fallback to simple hash
  const data = base64.slice(base64.indexOf(',') + 1); // strip data:image/...;base64,
  // Sample a subset for speed (first 8KB + last 4KB + length)
  const sample = data.slice(0, 8192) + data.slice(-4096) + data.length.toString();
  
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(sample));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { /* fallback */ }
  }
  
  // Simple DJB2 hash fallback
  let hash = 5381;
  for (let i = 0; i < sample.length; i++) {
    hash = ((hash << 5) + hash + sample.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(16);
}

// ---------- Image Dedup Cache ----------

interface CacheEntry {
  /** image hash + UI language (same image, different language = different cache entry) */
  hash: string;
  result: string; // JSON stringified DeepAnalysisResult
  timestamp: number;
}

function dedupKey(imageHash: string, uiLanguage?: string): string {
  const lang = (uiLanguage || "").trim() || "*";
  return `${imageHash}|${lang}`;
}

function getCache(): CacheEntry[] {
  try {
    const raw = storageGet(CACHE_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveCache(entries: CacheEntry[]): void {
  try {
    storageSet(CACHE_STORAGE_KEY, JSON.stringify(entries));
  } catch { /* ignore */ }
}

function findCachedResult(imageHash: string, uiLanguage?: string): string | null {
  const key = dedupKey(imageHash, uiLanguage);
  const cache = getCache();
  const entry = cache.find(e => e.hash === key);
  if (entry) {
    // Cache expires after 24 hours
    if (Date.now() - entry.timestamp < 24 * 60 * 60 * 1000) {
      return entry.result;
    }
  }
  return null;
}

function addToCache(imageHash: string, resultJson: string, maxEntries: number, uiLanguage?: string): void {
  const key = dedupKey(imageHash, uiLanguage);
  let cache = getCache();
  // Remove existing entry for same key
  cache = cache.filter(e => e.hash !== key);
  // Add new entry
  cache.unshift({ hash: key, result: resultJson, timestamp: Date.now() });
  // Trim to max
  if (cache.length > maxEntries) {
    cache = cache.slice(0, maxEntries);
  }
  saveCache(cache);
}

// ---------- Image Compression ----------

/** True when image is already within cloud vision max size (skip re-compress). */
export function isCloudAiImageSizeReady(
  dataUrl: string,
  cfg: Pick<GuardConfig, 'maxImageBytes'> = DEFAULT_GUARD_CONFIG,
): boolean {
  return estimateDataUrlBytes(dataUrl) <= cfg.maxImageBytes;
}

/** Compress for analyze and follow-up-with-image (no minimum size gate). */
export async function prepareImageForCloudAI(base64: string): Promise<string> {
  const cfg = cloudAIGuard.getConfig();
  if (isCloudAiImageSizeReady(base64, cfg)) {
    return base64;
  }
  return cloudAIGuard.compressImage(base64);
}

export async function compressImage(
  base64: string,
  maxSize: number = AI_VISION_IMAGE_LIMITS.maxSize,
  quality: number = AI_VISION_IMAGE_LIMITS.quality,
  maxBytes: number = AI_VISION_IMAGE_LIMITS.maxBytes,
): Promise<string> {
  return compressImageBase64(base64, {
    maxSize,
    quality,
    maxBytes,
    format: 'webp',
  });
}

// ---------- Main Guard Class ----------

export class CloudAIGuard {
  private config: GuardConfig;

  constructor(config?: Partial<GuardConfig>) {
    this.config = { ...DEFAULT_GUARD_CONFIG, ...config };
  }

  /** Update guard config */
  updateConfig(config: Partial<GuardConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Get current daily usage count */
  getDailyUsage(): { used: number; limit: number } {
    const usage = getUsage();
    return { used: usage.count, limit: this.config.dailyLimit };
  }

  /** Check if daily limit has been reached */
  isDailyLimitReached(): boolean {
    const usage = getUsage();
    return usage.count >= this.config.dailyLimit;
  }

  /** Get remaining cooldown in seconds (0 = ready) */
  getCooldownRemaining(): number {
    const usage = getUsage();
    if (usage.lastCallTimestamp === 0) return 0;
    const elapsed = (Date.now() - usage.lastCallTimestamp) / 1000;
    const remaining = this.config.cooldownSeconds - elapsed;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  /** Check if still in cooldown period */
  isInCooldown(): boolean {
    return this.getCooldownRemaining() > 0;
  }

  /** Record a successful API call (increment usage, update timestamp) */
  recordCall(): void {
    const usage = getUsage();
    usage.count++;
    usage.lastCallTimestamp = Date.now();
    saveUsage(usage);
  }

  /**
   * Sync a server-issued cooldown window (seconds) into local usage so the
   * existing `cooldownSec` UI countdown can show it without extra plumbing.
   * Called from CloudAIService when the Edge function returns 429 INTERVAL/WINDOW.
   */
  markServerCooldown(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const usage = getUsage();
    const effective = Math.max(0, this.config.cooldownSeconds - seconds);
    // Back-date lastCallTimestamp so getCooldownRemaining() == `seconds`
    usage.lastCallTimestamp = Date.now() - effective * 1000;
    saveUsage(usage);
  }

  /**
   * Sync a server-issued daily limit hit into local usage so the
   * existing dailyUsage UI shows "used == limit" immediately.
   */
  markDailyLimitReached(): void {
    const usage = getUsage();
    usage.count = Math.max(usage.count, this.config.dailyLimit);
    saveUsage(usage);
  }

  /** Compress image using configured settings (always re-encode via canvas + maxBytes cap) */
  async compressImage(base64: string): Promise<string> {
    return compressImageBase64(base64, {
      maxSize: this.config.maxImageSize,
      quality: this.config.imageQuality,
      maxBytes: this.config.maxImageBytes,
      format: 'webp',
    });
  }

  /** Check dedup cache for this image, returns cached result JSON or null */
  async checkDedup(imageBase64: string, uiLanguage?: string): Promise<string | null> {
    if (!this.config.enableDedup) return null;
    const hash = await hashImageBase64(imageBase64);
    const cached = findCachedResult(hash, uiLanguage);
    if (cached) {
      console.log(`[CloudAIGuard] Dedup hit! Image hash: ${hash.slice(0, 12)}...`);
    }
    return cached;
  }

  /** Cache a result for an image */
  async cacheResult(imageBase64: string, resultJson: string, uiLanguage?: string): Promise<void> {
    if (!this.config.enableDedup) return;
    const hash = await hashImageBase64(imageBase64);
    addToCache(hash, resultJson, this.config.maxCacheEntries, uiLanguage);
  }

  /** Get image hash for dedup tracking */
  async getImageHash(imageBase64: string): Promise<string> {
    return hashImageBase64(imageBase64);
  }

  /**
   * Pre-flight check: returns an error code if the request should be blocked.
   * Returns null if OK to proceed.
   */
  preflightCheck(): 'DAILY_LIMIT' | 'COOLDOWN' | null {
    if (this.isDailyLimitReached()) return 'DAILY_LIMIT';
    if (this.isInCooldown()) return 'COOLDOWN';
    return null;
  }

  /** Get config (for display in UI) */
  getConfig(): GuardConfig {
    return { ...this.config };
  }

  /** Clear all guard data (usage + cache) */
  clearAll(): void {
    try {
      storageRemove(GUARD_STORAGE_KEY);
      storageRemove(CACHE_STORAGE_KEY);
    } catch { /* ignore */ }
  }
}

// Singleton instance
export const cloudAIGuard = new CloudAIGuard();

/** Reset guard defaults then apply optional limits from cloudAIConfig */
export function syncCloudAIGuardFromRemoteConfig(c: {
  clientDailyLimit?: number;
  clientCooldownSeconds?: number;
  clientMaxImageSize?: number;
  clientImageQuality?: number;
} | undefined): void {
  cloudAIGuard.updateConfig({ ...DEFAULT_GUARD_CONFIG });
  if (!c) return;
  const patch: Partial<GuardConfig> = {};
  if (typeof c.clientDailyLimit === 'number' && Number.isFinite(c.clientDailyLimit) && c.clientDailyLimit >= 1) {
    patch.dailyLimit = Math.min(999, Math.floor(c.clientDailyLimit));
  }
  if (typeof c.clientCooldownSeconds === 'number' && Number.isFinite(c.clientCooldownSeconds) && c.clientCooldownSeconds >= 0) {
    patch.cooldownSeconds = Math.min(3600, Math.max(0, Math.floor(c.clientCooldownSeconds)));
  }
  if (typeof c.clientMaxImageSize === 'number' && Number.isFinite(c.clientMaxImageSize) && c.clientMaxImageSize >= 320) {
    patch.maxImageSize = Math.min(4096, Math.floor(c.clientMaxImageSize));
  }
  if (typeof c.clientImageQuality === 'number' && Number.isFinite(c.clientImageQuality) && c.clientImageQuality > 0 && c.clientImageQuality <= 1) {
    patch.imageQuality = c.clientImageQuality;
  }
  if (Object.keys(patch).length > 0) {
    cloudAIGuard.updateConfig(patch);
  }
}