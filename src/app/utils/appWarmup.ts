import { isNative } from './capacitor-bridge';

type ChunkLoader = () => Promise<unknown>;

/** JS chunk loaders only — no video or large image assets. */
export const WARMUP_BATCHES: ChunkLoader[][] = [
  [
    () => import('../components/LoginPage'),
    () => import('../components/HomePage'),
  ],
  [
    () => import('../components/MarketPage'),
    () => import('../components/CommunityPage'),
    () => import('../components/ProfilePage'),
    () => import('../components/SettingsPage'),
  ],
  [
    () => import('../components/AIAssistantPage'),
    () => import('../components/StatementPage'),
    () => import('../components/VideoFeedPage'),
    () => import('../components/QRScannerCapture'),
    () => import('../components/OAuthCallback'),
    () => import('../components/ConfigManagerGate').then((m) => ({ default: m.ConfigManagerGate })),
  ],
];

function scheduleIdle(fn: () => void): void {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fn, { timeout: 3000 });
  } else {
    setTimeout(fn, 1000);
  }
}

async function runBatch(loaders: ChunkLoader[]): Promise<void> {
  for (const load of loaders) {
    try {
      await load();
    } catch {
      /* individual chunk failures must not block later batches */
    }
  }
}

export async function runWarmupBatches(
  batches: ChunkLoader[][],
  schedule: (fn: () => void) => void = scheduleIdle,
): Promise<void> {
  for (const batch of batches) {
    await new Promise<void>((resolve) => {
      schedule(() => {
        void runBatch(batch).finally(resolve);
      });
    });
  }
}

/**
 * Native App: preload all route chunks in idle batches so Suspense fallbacks
 * are rarely hit. Web/PWA callers should use routes.preloadMainPages() instead.
 */
export async function warmupAllChunks(): Promise<void> {
  if (!isNative()) return;
  await runWarmupBatches(WARMUP_BATCHES);
}
