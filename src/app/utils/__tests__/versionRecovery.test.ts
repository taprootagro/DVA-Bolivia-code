import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from '../versionRecovery';

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
});
