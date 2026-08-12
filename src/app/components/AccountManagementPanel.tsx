import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { useEdgeProfile } from "../hooks/useEdgeProfile";
import { useContentSuperAdmin } from "../hooks/useContentSuperAdmin";
import { getServerUserId, isServerAssignedId } from "../utils/auth";
import { deleteAccount } from "../utils/accountDeletion";
import { toast } from "../utils/capacitor-bridge";
import { armProfileGateSkipAutoOnce } from "../utils/profileGateSkip";

function maskUserId(userId: string | null): string {
  const id = (userId || "").trim();
  if (!id) return "—";
  if (id.length <= 4) return id;
  return `…${id.slice(-4)}`;
}

function maskPhone(phone: string): string {
  const p = phone.trim();
  if (p.length < 7) return p || "—";
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

export function AccountManagementPanel() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const p = t.settings;
  const { displayName, phone } = useEdgeProfile();
  const { contentRole } = useContentSuperAdmin();
  const userId = getServerUserId();
  const serverAccount = isServerAssignedId();

  const [showConfirm, setShowConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const confirmWord =
    p.accountDeleteConfirmWord ||
    (language === "zh-TW" ? "刪除" : language === "zh" ? "删除" : "DELETE");
  const canSubmit =
    acknowledged && confirmText.trim() === confirmWord && !deleting;

  const accountSummary = useMemo(() => {
    const name = (displayName || "").trim() || p.accountManagementAnonymous || "—";
    return {
      name,
      phone: maskPhone(phone || ""),
      userId: maskUserId(userId),
    };
  }, [displayName, phone, userId, p.accountManagementAnonymous]);

  const handleDelete = async () => {
    if (!canSubmit) return;
    setDeleting(true);
    try {
      const result = await deleteAccount();
      if (!result.ok) {
        const msg =
          result.status === 401
            ? p.accountDeleteSessionExpired || t.profile.profileCloudSyncFailed
            : result.status === 429
              ? p.accountDeleteRateLimited
              : p.accountDeleteFailed;
        await toast.show({ text: msg || "Failed", duration: "long", position: "bottom" });
        return;
      }
      setShowConfirm(false);
      await toast.show({
        text: p.accountDeleteSuccess || "Account deleted",
        duration: "short",
        position: "bottom",
      });
      armProfileGateSkipAutoOnce();
      navigate("/home/profile", { replace: true });
    } finally {
      setDeleting(false);
    }
  };

  const openConfirm = () => {
    setAcknowledged(false);
    setConfirmText("");
    setShowConfirm(true);
  };

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-xl p-3 border border-gray-100 space-y-2">
        <p className="text-xs text-gray-500">{p.accountManagementSummaryHint}</p>
        <div className="text-sm text-gray-800 space-y-1">
          <p>
            <span className="text-gray-500">{p.accountManagementDisplayName}: </span>
            {accountSummary.name}
          </p>
          {accountSummary.phone !== "—" && (
            <p>
              <span className="text-gray-500">{p.accountManagementPhone}: </span>
              {accountSummary.phone}
            </p>
          )}
          <p>
            <span className="text-gray-500">{p.accountManagementUserId}: </span>
            <span className="font-mono text-xs">{accountSummary.userId}</span>
          </p>
          {!serverAccount && (
            <p className="text-xs text-amber-700">{p.accountManagementLocalOnlyHint}</p>
          )}
        </div>
      </div>

      {(contentRole === "admin" || contentRole === "editor") && (
        <div className="flex gap-2 items-start rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 leading-relaxed">{p.accountDeleteCmsWarning}</p>
        </div>
      )}

      <p className="text-xs text-gray-500 leading-relaxed whitespace-pre-line">
        {p.accountDeleteWarning}
      </p>

      <button
        type="button"
        onClick={openConfirm}
        className="w-full py-2.5 rounded-xl border border-red-200 bg-red-50 text-red-600 text-sm font-medium active:bg-red-100 transition-colors"
      >
        {p.accountDeleteTitle}
      </button>

      {showConfirm && (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center px-6"
          onClick={() => !deleting && setShowConfirm(false)}
        >
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 text-center mb-2">
              {p.accountDeleteTitle}
            </h3>
            <p className="text-sm text-gray-500 text-center mb-4 whitespace-pre-line">
              {p.accountDeleteConfirmDesc}
            </p>

            <label className="flex items-start gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm text-gray-700">{p.accountDeleteAck}</span>
            </label>

            <label className="block mb-4">
              <span className="text-xs text-gray-500 mb-1 block">{p.accountDeleteConfirmLabel}</span>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={confirmWord}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                autoComplete="off"
                autoCapitalize="characters"
              />
            </label>

            <div className="flex gap-3">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-3 rounded-2xl bg-gray-100 text-gray-600 text-sm font-medium active:bg-gray-200 transition-colors disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void handleDelete()}
                className="flex-1 py-3 rounded-2xl bg-red-500 text-white text-sm font-medium active:bg-red-600 transition-colors shadow-lg disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {deleting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {p.accountDeleteInProgress}
                  </>
                ) : (
                  p.accountDeleteTitle
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
