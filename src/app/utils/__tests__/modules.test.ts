// ============================================================================
// Core Utility Module Tests
// ============================================================================
// Proof-of-concept test suite demonstrating the testing stack in action.
// Run with: npx vitest run
//
// These tests target critical utilities:
//   1. deepMerge    — Pure function, backbone of all config merging
//   2. apiVersion   — Pure functions, version negotiation logic
//   3. safeStorage  — localStorage wrapper with degradation tracking
//   4. coordTransform — Coordinate system conversions (critical for maps/location)
//   5. videoEmbedFromUrl — URL parsing for video embed whitelist
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';

// ── deepMerge ───────────────────────────────────────────────────────────────

import {
  deepMerge,
  deepMergeAll,
  MERGE_REPLACE,
  MERGE_DEEP,
  MERGE_APPEND,
  MERGE_CONSERVATIVE,
} from '../deepMerge';

describe('deepMerge', () => {
  it('merges flat objects (replace strategy default)', () => {
    const target = { a: 1, b: 2 } as Record<string, unknown>;
    const source = { b: 3, c: 4 };
    const result = deepMerge(target, source, MERGE_REPLACE);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('deeply merges nested objects', () => {
    const target = { app: { name: 'Taproot', theme: 'emerald' } } as Record<string, unknown>;
    const source = { app: { theme: 'blue' } };
    const result = deepMerge(target, source, MERGE_DEEP);
    expect((result.app as Record<string, unknown>).name).toBe('Taproot');
    expect((result.app as Record<string, unknown>).theme).toBe('blue');
  });

  it('merge array strategy: replace (default)', () => {
    const result = deepMerge(
      { items: [1, 2, 3] } as Record<string, unknown>,
      { items: [4, 5] },
      MERGE_REPLACE
    );
    expect(result.items).toEqual([4, 5]);
  });

  it('merge array strategy: merge (index-based)', () => {
    const result = deepMerge(
      { items: [1, 2, 3] } as Record<string, unknown>,
      { items: [9, 8] },
      MERGE_DEEP
    );
    // Index 0, 1 from source; index 2 kept from target
    expect(result.items).toEqual([9, 8, 3]);
  });

  it('merge array strategy: append (dedup)', () => {
    const result = deepMerge(
      { items: ['a', 'b'] } as Record<string, unknown>,
      { items: ['b', 'c'] },
      MERGE_APPEND
    );
    expect(result.items).toEqual(['a', 'b', 'c']);
  });

  it('conservative strategy: skips null and undefined', () => {
    const target = { a: 1, b: 'original', c: true } as Record<string, unknown>;
    const source = { a: null, b: undefined, c: false };
    const result = deepMerge(target, source, MERGE_CONSERVATIVE);
    // nullStrategy: 'keep' — a stays 1
    // undefinedStrategy: 'skip' — b stays 'original'
    // c is a regular value — overwrites
    expect(result).toEqual({ a: 1, b: 'original', c: false });
  });

  it('returns new object (does not mutate target)', () => {
    const target = { x: 1 } as Record<string, unknown>;
    const source = { y: 2 };
    const result = deepMerge(target, source);
    expect(result).not.toBe(target);
    expect(result.y).toBe(2);
  });

  it('handles empty source', () => {
    const result = deepMerge({ a: 1 } as Record<string, unknown>, {});
    expect(result).toEqual({ a: 1 });
  });

  it('handles empty target', () => {
    const result = deepMerge({} as Record<string, unknown>, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it('custom merge function takes priority', () => {
    const target = { count: 0 } as Record<string, unknown>;
    const source = { count: 5 };
    const result = deepMerge(target, source, {
      customMerge: (_target, _source, key) => {
        if (key === 'count') return 100;
        return undefined;
      },
    });
    expect(result.count).toBe(100);
  });
});

describe('deepMergeAll', () => {
  it('merges multiple objects left to right', () => {
    const result = deepMergeAll([
      { a: 1 } as Record<string, unknown>,
      { b: 2 },
      { c: 3 },
    ]);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('later objects override earlier ones', () => {
    const result = deepMergeAll([
      { x: 'first' } as Record<string, unknown>,
      { x: 'second' },
      { x: 'third' },
    ]);
    expect(result.x).toBe('third');
  });

  it('returns empty object for empty input', () => {
    const result = deepMergeAll([]);
    expect(result).toEqual({});
  });

  it('returns single object as-is', () => {
    const obj = { solo: true } as Record<string, unknown>;
    const result = deepMergeAll([obj]);
    expect(result).toBe(obj);
  });
});

// ── apiVersion ──────────────────────────────────────────────────────────────

import {
  getVersionFallbackChain,
  registerTransformer,
  getPreferredVersion,
  saveLastSuccessVersion,
  getLastSuccessVersion,
} from '../apiVersion';
import type { ApiVersion } from '../apiVersion';

describe('getVersionFallbackChain', () => {
  it('returns full chain from v3', () => {
    expect(getVersionFallbackChain('v3')).toEqual(['v3', 'v2', 'v1']);
  });

  it('returns partial chain from v2', () => {
    expect(getVersionFallbackChain('v2')).toEqual(['v2', 'v1']);
  });

  it('returns only v1 from v1', () => {
    expect(getVersionFallbackChain('v1')).toEqual(['v1']);
  });

  it('defaults to v3 when no argument given', () => {
    expect(getVersionFallbackChain()).toEqual(['v3', 'v2', 'v1']);
  });

  it('falls back to full chain for unknown version', () => {
    expect(getVersionFallbackChain('v4' as ApiVersion)).toEqual(['v3', 'v2', 'v1']);
  });
});

describe('registerTransformer / version storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('registerTransformer does not throw', () => {
    expect(() => {
      registerTransformer('/test', 'v1', 'v2', (data) => ({ ...data as any, upgraded: true }));
    }).not.toThrow();
  });

  it('saveLastSuccessVersion stores version info', () => {
    saveLastSuccessVersion('/api/test', 'v2');
    const stored = localStorage.getItem('taproot_api_last_success_version');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed['/api/test'].version).toBe('v2');
    expect(parsed['/api/test'].timestamp).toBeGreaterThan(0);
  });

  it('getLastSuccessVersion returns null for unknown endpoint', () => {
    const version = getLastSuccessVersion('/api/nonexistent');
    expect(version).toBeNull();
  });

  it('getLastSuccessVersion returns stored version', () => {
    saveLastSuccessVersion('/api/example', 'v1');
    const version = getLastSuccessVersion('/api/example');
    expect(version).toBe('v1');
  });

  it('getPreferredVersion returns stored version when available', () => {
    saveLastSuccessVersion('/api/preferred', 'v2');
    const version = getPreferredVersion('/api/preferred', 'v3');
    expect(version).toBe('v2');
  });

  it('getPreferredVersion returns default when no stored version', () => {
    const version = getPreferredVersion('/api/new', 'v3');
    expect(version).toBe('v3');
  });

  it('getLastSuccessVersion returns null for expired entries (>7 days)', () => {
    // Simulate an old entry by manipulating localStorage directly
    const oldData = {
      '/api/old': { version: 'v1', timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000 },
    };
    localStorage.setItem('taproot_api_last_success_version', JSON.stringify(oldData));
    const version = getLastSuccessVersion('/api/old');
    expect(version).toBeNull();
  });
});

// ── safeStorage ─────────────────────────────────────────────────────────────

import {
  storageGetJSON,
  storageSetJSON,
  storageRemove,
  storageAvailable,
  getStorageHealth,
} from '../safeStorage';

describe('safeStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('storageGetJSON returns fallback when key is missing', () => {
    const result = storageGetJSON('missing_key', { fallback: true });
    expect(result).toEqual({ fallback: true });
  });

  it('storageSetJSON and storageGetJSON round-trip correctly', () => {
    storageSetJSON('test_key', { value: 42, nested: { deep: true } });
    const result = storageGetJSON<{ value: number; nested: { deep: boolean } }>('test_key', null);
    expect(result).toEqual({ value: 42, nested: { deep: true } });
  });

  it('storageRemove deletes the key', () => {
    storageSetJSON('deletable', { x: 1 });
    storageRemove('deletable');
    const result = storageGetJSON('deletable', 'FALLBACK');
    expect(result).toBe('FALLBACK');
  });

  it('storageAvailable returns true when localStorage works', () => {
    expect(storageAvailable()).toBe(true);
  });

  it('getStorageHealth returns health state object', () => {
    const health = getStorageHealth();
    expect(health).toHaveProperty('available');
    expect(health).toHaveProperty('failureCount');
    expect(health).toHaveProperty('lastFailure');
    expect(health).toHaveProperty('lastFailureOp');
  });
});

// ── coordTransform ──────────────────────────────────────────────────────────

import {
  wgs84ToGcj02,
  gcj02ToWgs84,
  convertCoord,
} from '../coordTransform';

describe('coordTransform', () => {
  it('wgs84ToGcj02 transforms coordinates with offset', () => {
    // Beijing approximate: [116.397428, 39.90923]
    const [lng, lat] = wgs84ToGcj02(116.397428, 39.90923);
    // GCJ-02 offset should be measurable but within ~500m of original
    const lngDiff = Math.abs(lng - 116.397428);
    const latDiff = Math.abs(lat - 39.90923);
    expect(lngDiff).toBeGreaterThan(0.0001);
    expect(lngDiff).toBeLessThan(0.01);
    expect(latDiff).toBeGreaterThan(0.0001);
    expect(latDiff).toBeLessThan(0.01);
  });

  it('gcj02ToWgs84 reverse transforms with minimal round-trip error', () => {
    const original: [number, number] = [116.391, 39.907];
    const gcj = wgs84ToGcj02(original[0], original[1]);
    const wgs = gcj02ToWgs84(gcj[0], gcj[1]);
    // Round-trip error should be very small (< ~1 meter)
    expect(Math.abs(wgs[0] - original[0])).toBeLessThan(0.00001);
    expect(Math.abs(wgs[1] - original[1])).toBeLessThan(0.00001);
  });

  it('returns coordinates outside China unchanged (outOfChina check)', () => {
    // London: [ -0.1276, 51.5074 ] — well outside China rectangle
    const [lng, lat] = wgs84ToGcj02(-0.1276, 51.5074);
    expect(lng).toBe(-0.1276);
    expect(lat).toBe(51.5074);
  });

  it('convertCoord: same system returns identity', () => {
    const result = convertCoord(120, 30, 'wgs84', 'wgs84');
    expect(result).toEqual([120, 30]);
  });

  it('convertCoord: wgs84 to gcj02 offset applied', () => {
    const result = convertCoord(116.397428, 39.90923, 'wgs84', 'gcj02');
    // Should differ from original
    expect(result[0]).not.toBe(116.397428);
    expect(result[1]).not.toBe(39.90923);
  });

  it('convertCoord: wgs84 -> gcj02 -> wgs84 round-trip', () => {
    const [lng, lat] = [116.391, 39.907];
    const gcj = convertCoord(lng, lat, 'wgs84', 'gcj02');
    const back = convertCoord(gcj[0], gcj[1], 'gcj02', 'wgs84');
    expect(Math.abs(back[0] - lng)).toBeLessThan(0.00001);
    expect(Math.abs(back[1] - lat)).toBeLessThan(0.00001);
  });
});

// ── videoEmbedFromUrl ───────────────────────────────────────────────────────

import {
  isYoutubeUserUrl,
  getNonYoutubeEmbedUrl,
  getYoutubeEmbedUrl,
  resolveLiveStreamEmbedUrl,
  isAllowedVideoIframeSrc,
} from '../videoEmbedFromUrl';

describe('isYoutubeUserUrl', () => {
  it('detects youtube.com/watch URLs', () => {
    expect(isYoutubeUserUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('detects youtu.be short URLs', () => {
    expect(isYoutubeUserUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('detects youtube-nocookie URLs', () => {
    expect(isYoutubeUserUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(true);
  });

  it('returns false for non-YouTube URLs', () => {
    expect(isYoutubeUserUrl('https://vimeo.com/123456')).toBe(false);
    expect(isYoutubeUserUrl('https://example.com/video')).toBe(false);
    expect(isYoutubeUserUrl('')).toBe(false);
  });
});

describe('getYoutubeEmbedUrl', () => {
  it('converts watch URLs to youtube-nocookie embed', () => {
    expect(getYoutubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('converts youtu.be short URLs', () => {
    expect(getYoutubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('passes through existing embed URLs as nocookie embed', () => {
    expect(getYoutubeEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('returns null for invalid YouTube URLs', () => {
    expect(getYoutubeEmbedUrl('https://www.youtube.com/')).toBeNull();
    expect(getYoutubeEmbedUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });
});

describe('resolveLiveStreamEmbedUrl', () => {
  it('resolves YouTube watch URLs', () => {
    expect(resolveLiveStreamEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('resolves Vimeo URLs', () => {
    expect(resolveLiveStreamEmbedUrl('https://vimeo.com/123456789')).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  it('resolves Bilibili URLs', () => {
    const url = resolveLiveStreamEmbedUrl('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(url).toContain('player.bilibili.com');
  });

  it('resolves Facebook watch URLs', () => {
    const url = resolveLiveStreamEmbedUrl('https://www.facebook.com/watch/?v=10153231379946729');
    expect(url).toContain('www.facebook.com/plugins/video.php');
  });

  it('returns null for direct MP4 links', () => {
    expect(resolveLiveStreamEmbedUrl('https://cdn.example.com/demo.mp4')).toBeNull();
  });
});

describe('getNonYoutubeEmbedUrl', () => {
  it('returns null for YouTube URLs (handled separately)', () => {
    expect(getNonYoutubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('generates Vimeo embed URL', () => {
    const url = getNonYoutubeEmbedUrl('https://vimeo.com/123456789');
    expect(url).toBe('https://player.vimeo.com/video/123456789');
  });

  it('generates Bilibili embed URL', () => {
    const url = getNonYoutubeEmbedUrl('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(url).toContain('player.bilibili.com');
    expect(url).toContain('BV1xx411c7mD');
  });

  it('generates Facebook embed URL', () => {
    const url = getNonYoutubeEmbedUrl('https://www.facebook.com/PlayStation/videos/10155554431506803/');
    expect(url).toContain('www.facebook.com/plugins/video.php');
    expect(url).toContain('10155554431506803');
  });

  it('returns null for unknown platforms', () => {
    expect(getNonYoutubeEmbedUrl('https://example.com/video.mp4')).toBeNull();
  });
});

describe('isAllowedVideoIframeSrc', () => {
  it('allows youtube embed URLs', () => {
    expect(isAllowedVideoIframeSrc('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(true);
  });

  it('allows youtube-nocookie embed URLs', () => {
    expect(isAllowedVideoIframeSrc('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(true);
  });

  it('allows vimeo embed URLs', () => {
    expect(isAllowedVideoIframeSrc('https://player.vimeo.com/video/123456789')).toBe(true);
  });

  it('allows bilibili player URLs', () => {
    expect(isAllowedVideoIframeSrc('https://player.bilibili.com/player.html?bvid=BV1xx')).toBe(true);
  });

  it('allows facebook plugin URLs', () => {
    expect(
      isAllowedVideoIframeSrc(
        'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D123&show_text=false&width=560',
      ),
    ).toBe(true);
  });

  it('rejects non-whitelisted domains', () => {
    expect(isAllowedVideoIframeSrc('https://evil.com/embed/video')).toBe(false);
    expect(isAllowedVideoIframeSrc('javascript:alert(1)')).toBe(false);
    expect(isAllowedVideoIframeSrc('data:text/html,<script>alert(1)</script>')).toBe(false);
  });
});
