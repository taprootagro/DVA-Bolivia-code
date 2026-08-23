import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { isChunkLoadError, recoverFromVersionMismatch, SOFT_RECOVERY_KEY } from '../versionRecovery';

describe('versionRecovery', () => {
  it('detects ChunkLoadError by name', () => {
    expect(isChunkLoadError(new Error('x'))).toBe(false);
    const err = new Error('Loading chunk 5 failed');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('detects dynamic import failure messages', () => {
    expect(
      isChunkLoadError(new Error('Failed to fetch dynamically imported module: http://localhost/assets/x.js')),
    ).toBe(true);
  });

  describe('recoverFromVersionMismatch', () => {
    beforeEach(() => {
      sessionStorage.clear();
      vi.stubGlobal('caches', {
        keys: async () => [],
      });
    });

    afterEach(() => {
      sessionStorage.clear();
      vi.unstubAllGlobals();
    });

    it('stops after max recoveries instead of looping reload or sw-reset', async () => {
      sessionStorage.setItem(SOFT_RECOVERY_KEY, '99');
      expect(await recoverFromVersionMismatch()).toBe('stop');
    });

    it('reloads on the first mismatch', async () => {
      expect(await recoverFromVersionMismatch()).toBe('reload');
    });
  });
});
