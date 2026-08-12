import { isAppPermissionEnabled } from './appPermissions';

/**
 * CameraManager — Global camera stream utility
 *
 * 解决 iOS PWA（尤其 iPhone 8 Plus 等低端设备）的核心问题：
 *
 * **分级约束降级**：当高分辨率约束失败时（常见于 WKWebView/PWA 模式），
 * 自动按 1920→1280→640→bare 逐级降低，直到找到能用的约束。
 *
 * 设计原则：用完即释放（不保活），不在后台占用摄像头硬件，节省电量。
 * 权限记忆依赖浏览器自身机制（iOS 15.4+ / Android Chrome 自动记住）。
 */

export type FacingMode = 'environment' | 'user';

interface ManagedStream {
  stream: MediaStream;
  facingMode: FacingMode;
  torchSupported: boolean;
}

// Progressive constraint levels — try highest first, fall back to lowest
const CONSTRAINT_LEVELS: MediaTrackConstraints[] = [
  { facingMode: '__FACING__' as any, width: { ideal: 1920 }, height: { ideal: 1080 } },
  { facingMode: '__FACING__' as any, width: { ideal: 1280 }, height: { ideal: 720 } },
  { facingMode: '__FACING__' as any, width: { ideal: 640 }, height: { ideal: 480 } },
  { facingMode: '__FACING__' as any }, // bare minimum — just open camera, any resolution
];

class CameraManager {
  private managed: ManagedStream | null = null;

  /**
   * Acquire a camera stream with progressive constraint fallback.
   * Every call creates a fresh stream（用完即释放，不保活）。
   */
  async acquire(facing: FacingMode = 'environment'): Promise<ManagedStream> {
    if (!isAppPermissionEnabled('camera')) {
      throw new CameraError(
        'DENIED',
        'Camera disabled in app settings. Enable it under Settings → Permissions.',
      );
    }

    // Stop any existing stream first
    this.release();

    // Check basic API availability
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError(
        'UNSUPPORTED',
        'Camera API not available. Ensure HTTPS and a supported browser.',
      );
    }

    // Try progressive constraint levels
    let lastError: any = null;
    for (const template of CONSTRAINT_LEVELS) {
      try {
        const constraints: MediaStreamConstraints = {
          video: {
            ...template,
            facingMode: facing,
          },
          audio: false,
        };

        console.log('[CameraManager] Trying constraints:', JSON.stringify(constraints.video));
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        // Check torch support
        const videoTrack = stream.getVideoTracks()[0];
        let torchSupported = false;
        try {
          const caps = videoTrack?.getCapabilities?.() as any;
          if (caps?.torch) torchSupported = true;
        } catch { /* ignore — getCapabilities not supported on all browsers */ }

        this.managed = { stream, facingMode: facing, torchSupported };

        console.log(`[CameraManager] Stream acquired (${facing}), torch=${torchSupported}`);
        return this.managed;
      } catch (err: any) {
        lastError = err;
        const name = err?.name || '';
        const msg = err?.message || '';
        console.warn(`[CameraManager] Constraint level failed:`, name, msg);

        // If user explicitly denied, don't try other constraints
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          throw new CameraError('DENIED', 'Camera permission denied by user.', err);
        }

        // If device is simply not available (e.g. no camera hardware)
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          throw new CameraError('NOT_FOUND', 'No camera found on this device.', err);
        }

        // OverconstrainedError / NotReadableError / AbortError — try next level
        continue;
      }
    }

    // All constraint levels exhausted
    throw new CameraError(
      'FAILED',
      'Could not start camera after trying all resolution levels.',
      lastError,
    );
  }

  /**
   * 立即停止 stream 并释放摄像头硬件。
   * 可安全重复调用（幂等）。
   */
  release() {
    if (this.managed) {
      this.managed.stream.getTracks().forEach(t => t.stop());
      this.managed = null;
      console.log('[CameraManager] Stream released');
    }
  }

  /**
   * Toggle torch (flashlight) on the current stream.
   */
  async toggleTorch(on: boolean): Promise<boolean> {
    if (!this.managed) return false;
    const track = this.managed.stream.getVideoTracks()[0];
    if (!track) return false;
    try {
      await (track as any).applyConstraints({ advanced: [{ torch: on } as any] });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the current active stream (or null).
   */
  get currentStream(): MediaStream | null {
    return this.managed?.stream ?? null;
  }

  get currentTorchSupported(): boolean {
    return this.managed?.torchSupported ?? false;
  }
}

/**
 * Typed camera error with category.
 */
export class CameraError extends Error {
  constructor(
    public code: 'UNSUPPORTED' | 'DENIED' | 'NOT_FOUND' | 'FAILED',
    message: string,
    public cause?: any,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

/**
 * Singleton — shared across all components in the app.
 */
export const cameraManager = new CameraManager();
