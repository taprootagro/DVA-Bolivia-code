// ============================================================================
// useMerchantBind — farmer side of the account-based QR flow
// ============================================================================
// Farmer scans a store QR (https://<whitelisted>/m/<merchant_user_id_uuid>),
// then calls Edge `merchant-bind-resolve?token=<merchant_uuid>` with Authorization: Bearer <access_token>.
//
// Store-scans-farmer (legacy `/f/<id>` inbound to store) is removed: the store
// directory is synced from Supabase via `storeBindingRepo.syncStorePeersFromCloud`
// as soon as a farmer scans — no manual confirmation needed on the store side.
// ============================================================================

import { useState, useEffect, useCallback } from "react";
import { useConfigContext } from "../../../hooks/ConfigProvider";
import { useLanguage } from "../../../hooks/useLanguage";
import { getAccessToken, getUserId } from "../../../utils/auth";

export interface MerchantBindScanResult {
  status: "verifying" | "verified" | "rejected";
  merchantData?: {
    merchantUserId: string;
    channelId: string;
    name: string;
    avatar: string;
    subtitle: string;
    imProvider: string;
  };
  sourceDomain?: string;
  rejectReason?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MERCHANT_PATH_RE = new RegExp(`^/m/(${UUID_RE.source.slice(1, -1)})/?$`, "i");

export function useMerchantBind(options?: {
  /** Kept for backward signature compatibility; unused now that peers cloud-sync. */
  onStorePeerAdded?: () => void;
  /**
   * When set, overrides `config.communityUiMode` for store vs farmer QR/bind behavior.
   * CommunityPage passes false for farmer shell and true for StoreCommunityShell.
   */
  isStoreShell?: boolean;
}) {
  const { config, saveConfig } = useConfigContext();
  const { t } = useLanguage();
  // onStorePeerAdded is accepted but no longer triggered (store peers now sync via cloud)
  void options?.onStorePeerAdded;

  const [showScanner, setShowScanner] = useState(false);
  const [showScanActionSheet, setShowScanActionSheet] = useState(false);
  const [scanResult, setScanResult] = useState<MerchantBindScanResult | null>(null);

  const [scanAlbumScanning, setScanAlbumScanning] = useState(false);
  const [scanAlbumError, setScanAlbumError] = useState("");
  const [scanSheetAnim, setScanSheetAnim] = useState<
    "entering" | "visible" | "leaving"
  >("entering");

  const isStoreMode =
    options?.isStoreShell !== undefined
      ? options.isStoreShell
      : config?.communityUiMode === "store";

  useEffect(() => {
    if (showScanActionSheet) {
      setScanSheetAnim("entering");
      requestAnimationFrame(() => setScanSheetAnim("visible"));
    }
  }, [showScanActionSheet]);

  const closeScanActionSheet = useCallback(() => {
    setScanSheetAnim("leaving");
    setTimeout(() => {
      setShowScanActionSheet(false);
      setScanAlbumError("");
    }, 200);
  }, []);

  const processScanResult = useCallback(
    (qrText: string) => {
      setScanResult({ status: "verifying" });

      void (async () => {
        try {
          const whitelist = (config?.chatContact?.verifiedDomains || [])
            .map((d: string) => d.toLowerCase().replace(/^www\./, "").trim())
            .filter(Boolean);

          let url: URL;
          try {
            url = new URL(qrText.trim());
          } catch {
            setScanResult({
              status: "rejected",
              rejectReason: "无法解析二维码内容 / Invalid QR code",
            });
            return;
          }
          const sourceDomain = url.hostname.replace(/^www\./, "");

          if (whitelist.length === 0) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                "未配置域名白名单，无法验证商家身份 / No verified domains configured",
            });
            return;
          }

          const isDomainVerified = whitelist.some(
            (allowed: string) =>
              sourceDomain === allowed || sourceDomain.endsWith("." + allowed),
          );
          if (!isDomainVerified) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason: `域名 "${sourceDomain}" 不在白名单中 / Domain not in whitelist`,
            });
            return;
          }

          if (isStoreMode) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                t.community?.storeScanRejectMerchantBindQr ??
                "门店无需扫码：农户扫本店二维码即可自动出现在联系人中 / Store: farmers appear automatically when they scan your QR",
            });
            return;
          }

          const match = url.pathname.match(MERCHANT_PATH_RE);
          const merchantUserId = (match?.[1] || "").toLowerCase();
          if (!merchantUserId || !UUID_RE.test(merchantUserId)) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                "二维码格式无效（需 /m/<merchant_user_id_uuid>） / QR must be /m/<merchant_user_id_uuid>",
            });
            return;
          }

          const farmerUserId = getUserId();
          if (!farmerUserId || !UUID_RE.test(farmerUserId)) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                t.community?.scanNeedFarmerLogin ??
                "请先登录后再扫码绑定门店 / Sign in before scanning the store QR",
            });
            return;
          }

          const accessToken = getAccessToken()?.trim();
          if (!accessToken) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                t.community?.scanNeedFarmerLogin ??
                "请先登录后再扫码绑定门店 / Sign in before scanning the store QR",
            });
            return;
          }

          const bpc = config?.backendProxyConfig;
          const base = bpc?.supabaseUrl?.replace(/\/$/, "");
          const key = bpc?.supabaseAnonKey;
          if (!base?.startsWith("https://") || !key) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                "短链解析需要配置 Supabase URL 与 Anon Key / Missing Supabase URL / Anon Key",
            });
            return;
          }

          const qs = new URLSearchParams({
            token: merchantUserId,
          });
          const bindDay = url.searchParams.get("day")?.trim();
          const bindSig = url.searchParams.get("sig")?.trim();
          if (bindDay) qs.set("day", bindDay);
          if (bindSig) qs.set("sig", bindSig);

          const res = await fetch(
            `${base}/functions/v1/merchant-bind-resolve?${qs.toString()}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                apikey: key,
              },
            },
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            const errCode = (data as { error?: string }).error;
            if (res.status === 429 && errCode === "RATE_LIMIT") {
              const ra = Number((data as { retry_after_seconds?: number }).retry_after_seconds);
              setScanResult({
                status: "rejected",
                sourceDomain,
                rejectReason:
                  Number.isFinite(ra) && ra > 0
                    ? `操作过于频繁，请约 ${Math.ceil(ra)} 秒后再试 / Too many attempts, retry in ~${Math.ceil(ra)}s`
                    : "操作过于频繁，请稍后再试 / Too many attempts, try again later",
              });
              return;
            }
            if (res.status === 429 && (errCode === "BIND_QUOTA_FARMER" || errCode === "BIND_QUOTA_MERCHANT")) {
              const ra = Number((data as { retry_after_seconds?: number }).retry_after_seconds);
              setScanResult({
                status: "rejected",
                sourceDomain,
                rejectReason:
                  errCode === "BIND_QUOTA_FARMER"
                    ? `今日绑定门店数已达上限，请明日再试 / Daily store bind limit reached${Number.isFinite(ra) && ra > 0 ? ` (~${Math.ceil(ra)}s)` : ""}`
                    : `该门店今日接待绑定过多，请明日再试 / Store daily bind limit${Number.isFinite(ra) && ra > 0 ? ` (~${Math.ceil(ra)}s)` : ""}`,
              });
              return;
            }
            if (res.status === 403 && errCode === "BIND_SIG_EXPIRED") {
              setScanResult({
                status: "rejected",
                sourceDomain,
                rejectReason:
                  "门店二维码已过期（按日更新），请向店员索取当日新码 / Store QR expired; ask staff for today's code",
              });
              return;
            }
            if (res.status === 403 && errCode === "INVALID_BIND_SIG") {
              setScanResult({
                status: "rejected",
                sourceDomain,
                rejectReason:
                  "无效或过期的绑定码，请重新扫描门店当日二维码 / Invalid bind signature",
              });
              return;
            }
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                (data.error as string) ||
                "二维码无效或门店未找到 / Invalid QR or merchant not found",
            });
            return;
          }

          const channelId = String(data.channelId ?? "").trim();
          if (!channelId) {
            setScanResult({
              status: "rejected",
              sourceDomain,
              rejectReason:
                "服务端未返回聊天室 ID / Server did not return channel id",
            });
            return;
          }

          setScanResult({
            status: "verified",
            sourceDomain,
            merchantData: {
              merchantUserId: String(data.merchantUserId ?? merchantUserId),
              channelId,
              name: String(data.name ?? ""),
              avatar: String(data.avatar ?? ""),
              subtitle: String(data.subtitle ?? ""),
              imProvider: String(data.imProvider ?? "supabase"),
            },
          });
        } catch {
          setScanResult({
            status: "rejected",
            rejectReason:
              "无法解析二维码内容，格式无效 / Invalid QR code format",
          });
        }
      })();
    },
    [
      config?.chatContact?.verifiedDomains,
      config?.backendProxyConfig,
      isStoreMode,
      t.community?.scanNeedFarmerLogin,
      t.community?.storeScanRejectMerchantBindQr,
    ],
  );

  const confirmBindMerchant = useCallback(() => {
    if (!scanResult || scanResult.status !== "verified" || !config) return;
    if (!scanResult.merchantData) return;

    const m = scanResult.merchantData;
    const updatedContact = {
      ...config.chatContact,
      merchantUserId: m.merchantUserId,
      channelId: m.channelId,
      name:
        String(m.name ?? "").trim() ||
        config.chatContact.name ||
        m.merchantUserId.slice(0, 8),
      avatar: String(m.avatar ?? "").trim() || config.chatContact.avatar,
      subtitle: "",
      verifiedDomains: config.chatContact.verifiedDomains,
      boundAt: Date.now(),
      boundFrom: scanResult.sourceDomain || "",
    };

    saveConfig({
      ...config,
      chatContact: updatedContact,
    });

    console.log("[Scan] Merchant bound:", updatedContact);
    setScanResult(null);
  }, [scanResult, config, saveConfig]);

  const handleScanAlbumFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      if (!window.BarcodeDetector) {
        setScanAlbumError(
          t.community?.qrNotSupported ||
            "QR detection not supported in this browser",
        );
        return;
      }

      setScanAlbumScanning(true);
      setScanAlbumError("");

      try {
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        const bitmap = await createImageBitmap(file);
        const barcodes = await detector.detect(bitmap);

        if (barcodes.length > 0 && barcodes[0].rawValue) {
          if (navigator.vibrate) navigator.vibrate(100);
          closeScanActionSheet();
          processScanResult(barcodes[0].rawValue);
        } else {
          setScanAlbumError(
            t.community?.noQrDetected ||
              "No QR code detected. Please try again.",
          );
        }
      } catch (err) {
        console.error("[Scan] Album scan error:", err);
        setScanAlbumError(
          t.community?.scanFailed || "Detection failed. Please try again.",
        );
      } finally {
        setScanAlbumScanning(false);
      }
    },
    [t.community, closeScanActionSheet, processScanResult],
  );

  return {
    showScanner,
    setShowScanner,
    showScanActionSheet,
    setShowScanActionSheet,
    scanResult,
    setScanResult,
    scanAlbumScanning,
    scanAlbumError,
    scanSheetAnim,
    closeScanActionSheet,
    processScanResult,
    confirmBindMerchant,
    handleScanAlbumFile,
  };
}
