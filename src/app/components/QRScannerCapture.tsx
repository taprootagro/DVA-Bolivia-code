/**
 * QRScannerCapture — PWA 兼容的二维码扫描组件（统一样式）
 *
 * 视觉：全屏相机预览 → 中心对准框(绿色圆角 + 扫描线) → 手电筒 → 关闭
 * 整个页面无任何文字，纯图标交互，适配低识字率用户。
 *
 * 相机可用时自动实时扫描（BarcodeDetector），
 * 相机不可用时降级为 file input（拍照 / 相册）。
 *
 * 使用全局 CameraManager：
 * - 分级约束降级（1920→1280→640→bare），兼容 iPhone 8 Plus 等低端设备
 * - 用完即释放，不在后台占用摄像头硬件
 */
import { useRef, useState, useEffect, useCallback } from "react";
import { X, Flashlight, FlashlightOff, Camera, ImageIcon } from "lucide-react";
import { cameraManager } from "../utils/cameraManager";
import { bridge, isNative } from "../utils/capacitor-bridge";

// ── BarcodeDetector type ────────────────────────────────────────
interface BarcodeDetectorResult {
  rawValue: string;
  format: string;
  boundingBox?: DOMRectReadOnly;
  cornerPoints?: Array<{ x: number; y: number }>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats: string[] }): {
        detect: (source: ImageBitmapSource) => Promise<BarcodeDetectorResult[]>;
      };
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

interface QRScannerCaptureProps {
  onScan: (decodedText: string) => void;
  onClose: () => void;
}

export function QRScannerCapture({ onScan, onClose }: QRScannerCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const scannedRef = useRef(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);

  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [scanLineY, setScanLineY] = useState(0);
  const [apiSupported, setApiSupported] = useState(true);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [useWebCamera, setUseWebCamera] = useState(!isNative());
  const [nativeScanning, setNativeScanning] = useState(isNative());

  // 过渡动画
  const [animPhase, setAnimPhase] = useState<"entering" | "visible" | "leaving">("entering");
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimPhase("visible"));
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── BarcodeDetector ───────────────────────────────────────────
  const detectorRef = useRef<InstanceType<NonNullable<typeof window.BarcodeDetector>> | null>(null);

  useEffect(() => {
    if (window.BarcodeDetector) {
      try {
        detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
        setApiSupported(true);
      } catch {
        setApiSupported(false);
      }
    } else {
      setApiSupported(false);
    }
  }, []);

  // ── Native barcode scanner (Capacitor App) ───────────────────
  useEffect(() => {
    if (!isNative() || useWebCamera) return;
    let cancelled = false;

    (async () => {
      try {
        setTorchSupported(true);
        const result = await bridge.barcodeScanner.scan();
        if (cancelled || scannedRef.current) return;
        if (result?.content) {
          scannedRef.current = true;
          if (navigator.vibrate) navigator.vibrate(100);
          onScan(result.content);
          return;
        }
      } catch {
        /* fall through to web camera */
      }
      if (!cancelled && !scannedRef.current) {
        setNativeScanning(false);
        setUseWebCamera(true);
      }
    })();

    return () => {
      cancelled = true;
      void bridge.barcodeScanner.stopScan();
    };
  }, [onScan, useWebCamera]);

  // ── Start camera (via global CameraManager) ──────────────────
  useEffect(() => {
    if (!useWebCamera) return;
    let cancelled = false;

    (async () => {
      try {
        const managed = await cameraManager.acquire('environment');

        if (cancelled) {
          if (videoRef.current) videoRef.current.srcObject = null;
          cameraManager.release();
          return;
        }

        setTorchSupported(managed.torchSupported);

        if (videoRef.current) {
          const video = videoRef.current;
          video.srcObject = managed.stream;
          const markReady = () => {
            if (!cancelled) setCameraReady(true);
          };
          video.onloadedmetadata = () => {
            void video.play().then(markReady).catch(markReady);
          };
          // Android WebView 有时不触发 loadedmetadata，直接 play 作为兜底
          void video.play().then(markReady).catch(() => {
            /* loadedmetadata handler retries */
          });
        }
      } catch {
        setCameraFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      // 用完即释放 — 立即停止摄像头，不保活
      if (videoRef.current) videoRef.current.srcObject = null;
      cameraManager.release();
    };
  }, [useWebCamera]);

  // ── Scan loop ─────────────────────────────────────────────────
  const scanFrame = useCallback(() => {
    if (scannedRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < video.HAVE_ENOUGH_DATA || !detectorRef.current) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }

    detectorRef.current
      .detect(video)
      .then((barcodes: BarcodeDetectorResult[]) => {
        if (scannedRef.current) return;
        if (barcodes.length > 0 && barcodes[0].rawValue) {
          scannedRef.current = true;
          if (navigator.vibrate) navigator.vibrate(100);
          if (videoRef.current) videoRef.current.srcObject = null;
          cameraManager.release();
          onScan(barcodes[0].rawValue);
          return;
        }
        rafRef.current = requestAnimationFrame(scanFrame);
      })
      .catch(() => {
        rafRef.current = requestAnimationFrame(scanFrame);
      });
  }, [onScan]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraReady || !apiSupported) return;
    const handlePlaying = () => { rafRef.current = requestAnimationFrame(scanFrame); };
    video.addEventListener("playing", handlePlaying);
    if (!video.paused) rafRef.current = requestAnimationFrame(scanFrame);
    return () => {
      video.removeEventListener("playing", handlePlaying);
      cancelAnimationFrame(rafRef.current);
    };
  }, [cameraReady, scanFrame, apiSupported]);

  // ── Scan line animation ───────────────────────────────────────
  useEffect(() => {
    let frame = 0;
    let animId = 0;
    const animate = () => {
      frame++;
      setScanLineY(((Math.sin(frame * 0.025) + 1) / 2) * 100);
      animId = requestAnimationFrame(animate);
    };
    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, []);

  // ── Torch ─────────────────────────────────────────────────────
  const toggleTorch = async () => {
    if (nativeScanning && !useWebCamera) {
      const ok = await bridge.barcodeScanner.setTorch(!torchOn);
      if (ok) setTorchOn(!torchOn);
      return;
    }
    const success = await cameraManager.toggleTorch(!torchOn);
    if (success) setTorchOn(!torchOn);
  };

  // ── Close ─────────────────────────────────────────────────────
  const handleClose = () => {
    scannedRef.current = true;
    setAnimPhase("leaving");
    cancelAnimationFrame(rafRef.current);
    void bridge.barcodeScanner.stopScan();
    if (videoRef.current) videoRef.current.srcObject = null;
    cameraManager.release();
    setTimeout(() => onClose(), 150);
  };

  // ── Scan image file ───────────────────────────────────────────
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    if (!detectorRef.current) return;

    try {
      const bitmap = await createImageBitmap(file);
      const barcodes = await detectorRef.current.detect(bitmap);

      if (barcodes.length > 0 && barcodes[0].rawValue) {
        scannedRef.current = true;
        if (navigator.vibrate) navigator.vibrate(100);
        if (videoRef.current) videoRef.current.srcObject = null;
        cameraManager.release();
        onScan(barcodes[0].rawValue);
      }
    } catch {}
  }, [onScan]);

  // ── Render ────────────────────────────────────────────────────
  const nativePreview = nativeScanning && !useWebCamera;

  return (
    <div
      className={`qr-scanner-ui fixed inset-0 z-50 flex flex-col ${nativePreview ? "bg-transparent" : "bg-black"}`}
      style={{
        transform: animPhase === "visible" ? "none" : "scale(0.96)",
        opacity: animPhase === "visible" ? 1 : 0,
        transition:
          animPhase === "leaving"
            ? "transform 150ms ease-in, opacity 150ms ease-in"
            : "transform 200ms ease-out, opacity 200ms ease-out",
        willChange: animPhase === "visible" ? "auto" : "transform, opacity",
      }}
    >
      <canvas ref={canvasRef} className="hidden" />

      {/* 隐藏的 file inputs */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileChange} className="hidden" />
      <input ref={albumInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />

      {/* ═══════ 主内容区 ═══════ */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {cameraFailed ? (
          /* 相机不可用降级 — 纯图标，无文字 */
          <div className="flex flex-col items-center gap-6">
            <button
              onClick={() => cameraInputRef.current?.click()}
              className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center active:scale-90 transition-transform"
            >
              <Camera className="w-10 h-10 text-emerald-400" />
            </button>
            <button
              onClick={() => albumInputRef.current?.click()}
              className="w-14 h-14 rounded-full bg-white/15 flex items-center justify-center active:scale-90 transition-transform border border-white/20"
            >
              <ImageIcon className="w-6 h-6 text-white" />
            </button>
          </div>
        ) : (
          <>
            {/* Web 相机预览；原生扫码时预览在 WebView 后方，这里保持透明 */}
            {useWebCamera && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-cover transition-opacity duration-200 ${cameraReady ? 'opacity-100' : 'opacity-0'}`}
                style={{ background: 'black' }}
              />
            )}

            {/* 暗角遮罩：只用 box-shadow 挖孔，避免整层半透明挡住原生相机 */}
            <div className="absolute inset-0 pointer-events-none">
              <div
                className="absolute bg-transparent"
                style={{
                  top: "50%", left: "50%", transform: "translate(-50%, -55%)",
                  width: "260px", height: "260px",
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)", borderRadius: "20px",
                }}
              />
            </div>

            {/* 四角标记 + 扫描线 */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ marginTop: '-5%' }}>
              <div className="w-[260px] h-[260px] relative">
                <div className="absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 border-emerald-400 rounded-tl-[20px]" />
                <div className="absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 border-emerald-400 rounded-tr-[20px]" />
                <div className="absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 border-emerald-400 rounded-bl-[20px]" />
                <div className="absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 border-emerald-400 rounded-br-[20px]" />
                {/* 绿色扫描线 */}
                <div
                  className="absolute left-2 right-2 h-[2px]"
                  style={{
                    top: `${scanLineY}%`,
                    background: 'linear-gradient(90deg, transparent 0%, #34d399 20%, #10b981 50%, #34d399 80%, transparent 100%)',
                    boxShadow: '0 0 8px 2px rgba(16,185,129,0.4)',
                  }}
                />
              </div>
            </div>

            {/* Web 相机加载中；原生预览不转圈，否则会盖住相机 */}
            {useWebCamera && !cameraReady && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
              </div>
            )}
          </>
        )}
      </div>

      {/* ═══════ 底部控制区 — 预留安全区，避免与手机导航栏/Home 指示条重合 ═══════ */}
      <div
        className="flex-shrink-0 bg-black/80 backdrop-blur-sm flex flex-col items-center gap-5 pt-5 pb-4"
        style={{ paddingBottom: 'max(calc(env(safe-area-inset-bottom, 0px) + 16px), 24px)' }}
      >
        {/* 手电筒 */}
        {!cameraFailed && (
          <button
            onClick={toggleTorch}
            disabled={!torchSupported}
            className={`w-12 h-12 rounded-full flex items-center justify-center active:scale-90 transition-all ${
              torchOn
                ? 'bg-yellow-400/20 ring-2 ring-yellow-400/50'
                : torchSupported
                  ? 'bg-white/10 active:bg-white/20'
                  : 'bg-white/5 opacity-30'
            }`}
          >
            {torchOn
              ? <Flashlight className="w-5 h-5 text-yellow-400" />
              : <FlashlightOff className="w-5 h-5 text-white/70" />
            }
          </button>
        )}

        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center active:scale-90 transition-transform border border-white/20 mb-2"
        >
          <X className="w-6 h-6 text-white/90" />
        </button>
      </div>
    </div>
  );
}