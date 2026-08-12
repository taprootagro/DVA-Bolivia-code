import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { X, Copy, Check } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import { getAccessToken } from "../utils/auth";

interface StoreBindQRCardProps {
  onClose: () => void;
  userId: string;
}

/**
 * Account-based store QR (new flow).
 *
 * QR content:  https://<firstVerifiedDomain>/m/<merchant_user_id_uuid>[?day=&sig=]
 * 若部署了 merchant-bind-qr-url 且门店已登录，优先拉取当日 HMAC 签名路径（与 MERCHANT_BIND_REQUIRE_SIG 配套）。
 * 展示信息仍由 merchant-bind-resolve 从 user_profiles 返回。
 */
export function StoreBindQRCard({ onClose, userId }: StoreBindQRCardProps) {
  const { t } = useLanguage();
  const { config } = useConfigContext();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [qrValue, setQrValue] = useState("");

  const firstDomain = useMemo(() => {
    const raw = config?.chatContact?.verifiedDomains?.[0];
    if (!raw) return "";
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
  }, [config?.chatContact?.verifiedDomains]);

  const bpc = config?.backendProxyConfig;
  const supabaseBase = bpc?.supabaseUrl?.replace(/\/$/, "");
  const supabaseAnon = bpc?.supabaseAnonKey;

  useEffect(() => {
    if (!userId || !firstDomain) {
      setQrValue("");
      return;
    }
    const fallback = `https://${firstDomain}/m/${userId}`;
    if (!supabaseBase?.startsWith("https://") || !supabaseAnon) {
      setQrValue(fallback);
      return;
    }
    let cancelled = false;
    void (async () => {
      const token = getAccessToken()?.trim();
      if (!token) {
        if (!cancelled) setQrValue(fallback);
        return;
      }
      try {
        const res = await fetch(`${supabaseBase}/functions/v1/merchant-bind-qr-url`, {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: supabaseAnon,
          },
        });
        const data = await res.json().catch(() => ({}));
        if (
          !cancelled &&
          res.ok &&
          data?.ok === true &&
          typeof data.pathQuery === "string" &&
          data.pathQuery.startsWith("/m/")
        ) {
          setQrValue(`https://${firstDomain}${data.pathQuery}`);
          return;
        }
      } catch {
        /* use fallback */
      }
      if (!cancelled) setQrValue(fallback);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, firstDomain, supabaseBase, supabaseAnon]);

  const copyLink = useCallback(async () => {
    if (!qrValue) return;
    try {
      await navigator.clipboard.writeText(qrValue);
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(t.profile.storeBindQrCopyFailed ?? "");
    }
  }, [qrValue, t.profile.storeBindQrCopyFailed]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />

      <div
        className="relative w-[min(100vw-32px,320px)] max-h-[90vh] overflow-y-auto bg-white rounded-3xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "slideUpIn 300ms ease-out" }}
      >
        <div className="pt-6 px-5 pb-2">
          <h3 className="text-base font-bold text-gray-900 text-center">
            {t.profile.storeBindQrTitle ?? "Store bind QR"}
          </h3>
          <p className="text-[11px] text-gray-500 text-center mt-1.5 leading-relaxed">
            {t.profile.storeQrAccountOnlyHint ?? t.profile.storeBindQrHint ?? ""}
          </p>
        </div>

        <div className="px-5 pb-4 space-y-3">
          {!firstDomain ? (
            <p className="text-xs text-amber-700 bg-amber-50 rounded-xl px-3 py-2 leading-relaxed">
              {t.profile.storeBindQrNeedDomain ??
                "Configure a verified domain in ConfigManager → Chat to generate a scannable URL."}
            </p>
          ) : (
            <>
              <div className="bg-white p-3 rounded-2xl border border-gray-100 shadow-inner flex items-center justify-center">
                <QRCodeCanvas
                  value={qrValue || `https://${firstDomain}/m/${userId}`}
                  size={200}
                  level="M"
                  marginSize={2}
                  fgColor="#064e3b"
                  bgColor="#ffffff"
                />
              </div>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gray-100 text-sm text-gray-800 active:bg-gray-200"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                {copied ? (t.profile.codeCopied ?? "Copied") : (t.profile.storeBindQrCopyLink ?? "Copy link")}
              </button>
              <p className="text-[10px] text-gray-400 break-all leading-snug">
                {qrValue || `https://${firstDomain}/m/${userId}`}
              </p>
              {copyError ? <p className="text-xs text-red-600">{copyError}</p> : null}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mx-auto mb-6 w-12 h-12 rounded-full bg-red-500 flex items-center justify-center shadow-lg active:scale-90 transition-transform"
          aria-label={t.common.close}
        >
          <X className="w-5 h-5 text-white" />
        </button>
      </div>
    </div>
  );
}

export default StoreBindQRCard;
