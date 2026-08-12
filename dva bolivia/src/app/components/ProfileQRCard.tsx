import { QRCodeCanvas } from "qrcode.react";
import { X } from "lucide-react";
import { useMemo } from "react";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useLanguage } from "../hooks/useLanguage";

interface ProfileQRCardProps {
  onClose: () => void;
  userId: string;
  name: string;
}

function ProfileQRCardInner({ onClose, userId, name }: ProfileQRCardProps) {
  const { config } = useConfigContext();
  const { t } = useLanguage();

  const qrValue = useMemo(() => {
    const id = (userId || "").trim();
    if (!id) return "unknown";
    const domains = config?.chatContact?.verifiedDomains;
    const host = domains?.[0]?.replace(/^www\./, "").trim();
    if (!host) return id;
    const base = `https://${host}/f/${encodeURIComponent(id)}`;
    const n = (name || "").trim();
    if (n) {
      return `${base}?name=${encodeURIComponent(n)}`;
    }
    return base;
  }, [userId, name, config?.chatContact?.verifiedDomains]);

  const isFarmerLink = /^https:\/\//i.test(qrValue);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />

      <div
        className="relative w-[min(100vw-32px,300px)] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "slideUpIn 300ms ease-out" }}
      >
        {isFarmerLink && (
          <div className="px-4 pt-5 pb-1 text-center">
            <p className="text-xs text-gray-500 leading-relaxed">
              {t.profile?.farmerQrHint ?? "门店可扫此码将您加入通讯录"}
            </p>
          </div>
        )}
        <div className={`pb-6 px-6 ${isFarmerLink ? "pt-4" : "pt-5"}`}>
          <div className="bg-white p-3 rounded-2xl border border-gray-100 shadow-inner flex items-center justify-center">
            <QRCodeCanvas
              value={qrValue}
              size={220}
              level="M"
              marginSize={2}
              fgColor="#064e3b"
              bgColor="#ffffff"
            />
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-12 h-12 mb-6 rounded-full bg-red-500 flex items-center justify-center shadow-lg active:scale-90 transition-transform"
          aria-label={t.common?.close ?? "Close"}
        >
          <X className="w-5 h-5 text-white" />
        </button>
      </div>
    </div>
  );
}

export default ProfileQRCardInner;
