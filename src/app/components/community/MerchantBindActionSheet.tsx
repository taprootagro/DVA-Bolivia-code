import React, { lazy, Suspense } from "react";
import { ScanLine, ImageIcon, Loader, AlertCircle, ShieldCheck, ShieldX } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";
import type { MerchantBindScanResult } from "./hooks/useMerchantBind";

// QRScannerCapture 涉及相机 API，按需加载
const LazyQRScannerCapture = lazy(() =>
  import("../QRScannerCapture").then((m) => ({ default: m.QRScannerCapture }))
);

interface MerchantBindActionSheetProps {
  showScanner: boolean;
  setShowScanner: (show: boolean) => void;
  showScanActionSheet: boolean;
  scanSheetAnim: 'entering' | 'visible' | 'leaving';
  closeScanActionSheet: () => void;
  scanAlbumInputRef: React.RefObject<HTMLInputElement | null>;
  handleScanAlbumFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  scanAlbumScanning: boolean;
  scanAlbumError: string;
  scanResult: MerchantBindScanResult | null;
  setScanResult: (result: any) => void;
  confirmBindMerchant: () => void;
  handleQRScanResult: (text: string) => void;
}

export const MerchantBindActionSheet = React.memo(function MerchantBindActionSheet({
  showScanner,
  setShowScanner,
  showScanActionSheet,
  scanSheetAnim,
  closeScanActionSheet,
  scanAlbumInputRef,
  handleScanAlbumFile,
  scanAlbumScanning,
  scanAlbumError,
  scanResult,
  setScanResult,
  confirmBindMerchant,
  handleQRScanResult,
}: MerchantBindActionSheetProps) {
  const { t } = useLanguage();
  return (
    <>
      {showScanner && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
              <div className="w-10 h-10 border-3 border-white/30 border-t-white rounded-full animate-spin" />
            </div>
          }
        >
          <LazyQRScannerCapture onScan={handleQRScanResult} onClose={() => setShowScanner(false)} />
        </Suspense>
      )}
      <input ref={scanAlbumInputRef} type="file" accept="image/*" onChange={handleScanAlbumFile} className="hidden" />

      {/* 扫码结果弹窗 */}
      {scanResult && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
            {scanResult.status === "verifying" && (
              <div className="p-8 text-center">
                <div className="w-16 h-16 mx-auto mb-4 bg-emerald-100 rounded-full flex items-center justify-center animate-pulse">
                  <ScanLine className="w-8 h-8 text-emerald-600" />
                </div>
                <p className="text-gray-700 font-medium">{t.community?.verifyingDomain || "Verifying domain..."}</p>
              </div>
            )}
            {scanResult.status === "verified" && scanResult.merchantData && (
              <div>
                <div className="bg-gradient-to-br from-emerald-500 to-emerald-600 p-5 text-center">
                  <div className="w-14 h-14 mx-auto mb-2 bg-white/20 rounded-full flex items-center justify-center">
                    <ShieldCheck className="w-7 h-7 text-white" />
                  </div>
                  <p className="text-white font-semibold">{t.community?.domainVerified || "Domain Verified"}</p>
                  <p className="text-white/70 text-xs mt-0.5">{scanResult.sourceDomain}</p>
                </div>
                <div className="p-5 space-y-3">
                  <div className="flex items-center gap-3">
                    {scanResult.merchantData.avatar ? (
                      <img src={scanResult.merchantData.avatar} alt="" className="w-12 h-12 rounded-full object-cover ring-2 ring-emerald-100" />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 font-semibold text-lg">
                        {(scanResult.merchantData.name || "?").charAt(0)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{scanResult.merchantData.name || scanResult.merchantData.merchantUserId.slice(0, 8)}</p>
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between gap-2">
                      <span className="text-gray-500 flex-shrink-0">{t.community?.channelIdLabel || "Channel ID"}</span>
                      <span className="text-gray-800 font-mono text-right break-all">{scanResult.merchantData.channelId}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-gray-500 flex-shrink-0">{t.community?.imProviderLabel || "IM Provider"}</span>
                      <span className="text-gray-800">{scanResult.merchantData.imProvider}</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-amber-600 bg-amber-50 rounded-lg p-2">
                    {t.community?.bindWarning || "Confirming will overwrite the current chat contact configuration."}
                  </p>
                </div>
                <div className="flex" style={{ boxShadow: '0 -1px 4px rgba(0,0,0,0.04)' }}>
                  <button type="button" onClick={() => setScanResult(null)} className="flex-1 py-3.5 text-gray-600 font-medium text-sm active:bg-gray-50 transition-colors">{t.common?.cancel || "Cancel"}</button>
                  <div className="w-px bg-gray-100" />
                  <button type="button" onClick={confirmBindMerchant} className="flex-1 py-3.5 text-emerald-600 font-semibold text-sm active:bg-emerald-50 transition-colors">{t.community?.confirmBind || "Confirm Bind"}</button>
                </div>
              </div>
            )}
            {scanResult.status === "rejected" && (
              <div>
                <div className="bg-gradient-to-br from-red-500 to-red-600 p-5 text-center">
                  <div className="w-14 h-14 mx-auto mb-2 bg-white/20 rounded-full flex items-center justify-center">
                    <ShieldX className="w-7 h-7 text-white" />
                  </div>
                  <p className="text-white font-semibold">{t.community?.domainFailed || "Domain Verification Failed"}</p>
                </div>
                <div className="p-5 space-y-3">
                  {scanResult.sourceDomain && <div className="bg-red-50 rounded-xl p-3"><p className="text-xs text-red-600 font-mono">{t.community?.sourceLabel || "Source"}: {scanResult.sourceDomain}</p></div>}
                  <p className="text-sm text-gray-700">{scanResult.rejectReason}</p>
                  <p className="text-[10px] text-gray-400">
                    {t.community?.domainRejectedHint || "For your security, only QR codes from whitelisted domains can bind merchant contacts. Please contact your agricultural service provider for the correct QR code."}
                  </p>
                </div>
                <div style={{ boxShadow: '0 -1px 4px rgba(0,0,0,0.04)' }}>
                  <button onClick={() => setScanResult(null)} className="w-full py-3.5 text-gray-600 font-medium text-sm active:bg-gray-50 transition-colors">{t.community?.gotIt || "Got it"}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============ 扫码 Action Sheet ============ */}
      {showScanActionSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) closeScanActionSheet(); }}
          style={{
            backgroundColor: scanSheetAnim === 'visible' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0)',
            transition: 'background-color 200ms ease-out',
          }}
        >
          <div
            className="w-full max-w-lg mx-2 mb-2 safe-bottom"
            style={{
              transform: scanSheetAnim === 'visible' ? 'translateY(0)' : 'translateY(100%)',
              opacity: scanSheetAnim === 'leaving' ? 0 : 1,
              transition: scanSheetAnim === 'leaving'
                ? 'transform 200ms ease-in, opacity 150ms ease-in'
                : 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out',
            }}
          >
            {/* 选项组 */}
            <div className="bg-white rounded-2xl overflow-hidden shadow-xl">
              {/* 标题 */}
              <div className="px-4 pt-4 pb-2 text-center">
                <p className="text-gray-400" style={{ fontSize: '13px' }}>
                  {t.camera?.chooseSource || "Choose image source"}
                </p>
              </div>

              {/* 扫码（相机） — 打开 QRScannerCapture */}
              <button
                className="w-full flex items-center justify-center gap-3 py-4 active:bg-gray-50 transition-colors"
                style={{ boxShadow: '0 -1px 0 rgba(0,0,0,0.04)' }}
                onClick={() => {
                  closeScanActionSheet();
                  setTimeout(() => setShowScanner(true), 220);
                }}
              >
                <ScanLine className="w-5 h-5 text-emerald-600" />
                <span className="text-emerald-600" style={{ fontSize: '17px' }}>
                  {t.camera?.takePicture || "Take Photo"}
                </span>
              </button>

              {/* 从相册选择 — 用 BarcodeDetector 识别 */}
              <button
                className="w-full flex items-center justify-center gap-3 py-4 active:bg-gray-50 transition-colors"
                style={{ boxShadow: '0 -1px 0 rgba(0,0,0,0.04)' }}
                onClick={() => scanAlbumInputRef.current?.click()}
                disabled={scanAlbumScanning}
              >
                {scanAlbumScanning ? (
                  <>
                    <Loader className="w-5 h-5 text-emerald-600 animate-spin" />
                    <span className="text-emerald-600" style={{ fontSize: '17px' }}>
                      {t.community?.scanning || "Scanning..."}
                    </span>
                  </>
                ) : (
                  <>
                    <ImageIcon className="w-5 h-5 text-emerald-600" />
                    <span className="text-emerald-600" style={{ fontSize: '17px' }}>
                      {t.camera?.chooseFromAlbum || "Choose from Album"}
                    </span>
                  </>
                )}
              </button>

              {/* 相册识别错误提示 */}
              {scanAlbumError && (
                <div className="px-4 pb-3">
                  <div className="bg-red-50 rounded-xl px-3 py-2 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <p className="text-red-500 text-xs">{scanAlbumError}</p>
                  </div>
                </div>
              )}
            </div>

            {/* 取消按钮 */}
            <button
              className="mt-2 w-full bg-white rounded-2xl py-4 flex items-center justify-center active:bg-gray-50 transition-colors shadow-xl"
              onClick={closeScanActionSheet}
            >
              <span className="text-gray-900 font-medium" style={{ fontSize: '17px' }}>
                {t.common?.cancel || "Cancel"}
              </span>
            </button>
          </div>
        </div>
      )}
    </>
  );
});
