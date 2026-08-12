/**
 * Soft recovery for deploy/chunk mismatches — clear shell caches and reload
 * before falling through to /sw-reset (full reset).
 */

export const SOFT_RECOVERY_KEY = 'taproot_soft_recovery_count';
export const CHUNK_RELOAD_KEY = 'taproot_chunk_reload';
export const EB_RELOAD_COUNT_KEY = '__taproot_eb_reload_count__';

const SOFT_RECOVERY_MAX = 3;

export type RecoveryAction = 'reload' | 'sw-reset';

export function isChunkLoadError(reason: unknown): boolean {
  if (reason instanceof Error) {
    const msg = reason.message || '';
    const name = reason.name || '';
    return (
      name === 'ChunkLoadError' ||
      msg.includes('Loading chunk') ||
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('Importing a module script failed') ||
      msg.includes('error loading dynamically imported module') ||
      msg.includes('Unable to preload CSS')
    );
  }
  return false;
}

/** Remove cached index.html, /, and /assets/* from taproot-agro caches */
export async function clearTaprootShellCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;

  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith('taproot-agro'))
      .map(async (name) => {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        await Promise.all(
          keys.map((req) => {
            try {
              const pathname = new URL(req.url).pathname;
              if (
                pathname === '/index.html' ||
                pathname === '/' ||
                pathname.startsWith('/assets/')
              ) {
                return cache.delete(req);
              }
            } catch {
              /* ignore malformed URL */
            }
            return Promise.resolve(false);
          }),
        );
      }),
  );
}

export async function triggerServiceWorkerUpdate(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  } catch {
    /* ignore */
  }
}

/** Increment counter; return sw-reset when soft recovery exhausted */
export async function recoverFromVersionMismatch(): Promise<RecoveryAction> {
  const raw = sessionStorage.getItem(SOFT_RECOVERY_KEY);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= SOFT_RECOVERY_MAX) {
    sessionStorage.removeItem(SOFT_RECOVERY_KEY);
    return 'sw-reset';
  }

  sessionStorage.setItem(SOFT_RECOVERY_KEY, String(count + 1));
  await clearTaprootShellCaches();
  await triggerServiceWorkerUpdate();
  return 'reload';
}

export function clearRecoveryCounters(): void {
  try {
    sessionStorage.removeItem(SOFT_RECOVERY_KEY);
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    sessionStorage.removeItem(EB_RELOAD_COUNT_KEY);
  } catch {
    /* ignore */
  }
}

export async function executeVersionRecovery(): Promise<void> {
  const action = await recoverFromVersionMismatch();
  if (action === 'sw-reset') {
    window.location.href = '/sw-reset';
  } else {
    window.location.reload();
  }
}
