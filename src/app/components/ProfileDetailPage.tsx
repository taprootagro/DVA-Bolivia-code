import { useState, useRef, useCallback, useEffect } from "react";
import { Camera, User, Copy, Check } from "lucide-react";
import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import {
  getUserId,
  isServerAssignedId,
  getSessionAccessTokenForEdge,
} from "../utils/auth";
import { getSupabaseBrowserClient } from "../utils/supabaseBrowser";
import { extractGoogleLinkedEmail } from "../utils/authLinkedAccounts";
import {
  getLinkedGoogleCache,
  setLinkedGoogleCache,
} from "../utils/linkedGoogleCache";
import {
  formatProfileEditCooldownMessage,
  getProfileEditCooldownRemainingMs,
  recordProfileEditCooldownSave,
} from "../utils/profileEditCooldown";
import { compressImageFile, COMPRESS_PRESETS } from "../utils/imageCompressor";

const AVATAR_CLIENT_MAX = 400_000;
/** data: 头像超过此长度则不放进 POST body，避免 Edge/浏览器内存尖峰导致失败或闪退；文字资料仍同步 */
const AVATAR_DATA_URL_EDGE_MAX = 96_000;
const PICKUP_MAX = 200;

export interface EdgeProfileSnapshot {
  displayName: string;
  phone: string;
  pickupAddress: string;
  avatarUrl: string;
}

interface ProfileDetailPageProps {
  onClose: () => void;
  /** 来自 Edge GET /profile 的 profile JSON（扩展字段） */
  dbProfile?: Record<string, unknown> | null;
  /** 来自 Edge 列字段，优先于 dbProfile / 本地 */
  edgeSnapshot?: EdgeProfileSnapshot | null;
  profileLoading?: boolean;
  profileError?: string | null;
  onRemoteProfileSaved?: () => void;
  /** Edge 判定资料是否已完善；未完善时不做编辑频率限制（首次填写可多次保存） */
  profileCompleted?: boolean;
}

export function ProfileDetailPage({
  onClose,
  dbProfile = null,
  edgeSnapshot = null,
  profileLoading = false,
  profileError = null,
  onRemoteProfileSaved,
  profileCompleted = false,
}: ProfileDetailPageProps) {
  const { t } = useLanguage();
  const { config, saveConfig } = useConfigContext();

  const userId = getUserId();
  const isServer = isServerAssignedId();

  const [name, setName] = useState(
    isServer ? "" : config?.userProfile?.name || "",
  );
  const [avatar, setAvatar] = useState(
    isServer ? "" : config?.userProfile?.avatar || "",
  );
  const [phone, setPhone] = useState(
    (isServer ? "" : config?.userProfile?.phone || "").trim(),
  );
  const [pickup, setPickup] = useState(
    (isServer ? "" : config?.userProfile?.pickupAddress || "").slice(
      0,
      PICKUP_MAX,
    ),
  );
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkedGoogleEmail, setLinkedGoogleEmail] = useState<string>(() =>
    isServer ? (getLinkedGoogleCache() ?? "") : "",
  );

  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isServer) {
      setLinkedGoogleEmail("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const client = getSupabaseBrowserClient();
      if (!client) return;
      const { data: { user } } = await client.auth.getUser();
      if (cancelled) return;
      const g = extractGoogleLinkedEmail(user ?? undefined);
      if (g) {
        setLinkedGoogleCache(g);
        setLinkedGoogleEmail(g);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isServer]);

  /** 不设 closeBlocked：若禁止关闭，用户点返回/X 不会触发 onClose，父组件的 dismissed 标记永远为 false，切换 Tab 后编辑层仍在，表现为「每次点我的都弹出」。 */
  useEffect(() => {
    const snap = edgeSnapshot;
    if (snap) {
      if (isServer) {
        setName(snap.displayName || "");
        setAvatar(snap.avatarUrl || "");
        setPhone((snap.phone || "").trim());
        setPickup((snap.pickupAddress || "").slice(0, PICKUP_MAX));
      } else {
        setName(snap.displayName || config?.userProfile?.name || "");
        setAvatar(snap.avatarUrl || config?.userProfile?.avatar || "");
        setPhone((snap.phone || config?.userProfile?.phone || "").trim());
        setPickup(
          (snap.pickupAddress || config?.userProfile?.pickupAddress || "").slice(
            0,
            PICKUP_MAX,
          ),
        );
      }
      return;
    }
    const p = dbProfile;
    const fromDbPhone = p && typeof p.phone === "string" ? p.phone : "";
    const fromDbName = p && typeof p.name === "string" ? p.name : "";
    const fromDbAvatar = p && typeof p.avatar === "string" ? p.avatar : "";
    const fromDbPickup =
      p && typeof p.pickup_address === "string"
        ? p.pickup_address
        : p && typeof p.pickupAddress === "string"
          ? p.pickupAddress
          : "";
    if (isServer) {
      setPhone((fromDbPhone || "").trim());
      setName(fromDbName || "");
      setAvatar(fromDbAvatar || "");
      setPickup((fromDbPickup || "").slice(0, PICKUP_MAX));
    } else {
      setPhone((fromDbPhone || config?.userProfile?.phone || "").trim());
      setName(fromDbName || config?.userProfile?.name || "");
      setAvatar(fromDbAvatar || config?.userProfile?.avatar || "");
      setPickup(
        (fromDbPickup || config?.userProfile?.pickupAddress || "").slice(
          0,
          PICKUP_MAX,
        ),
      );
    }
  }, [
    dbProfile,
    edgeSnapshot,
    isServer,
    config?.userProfile?.phone,
    config?.userProfile?.name,
    config?.userProfile?.avatar,
    config?.userProfile?.pickupAddress,
  ]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const handleAvatarChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (avatarInputRef.current) avatarInputRef.current.value = "";

    try {
      // compressImageFile 已返回 data URL 字符串，勿再 readAsDataURL（会抛错并落入 catch 用原图）
      const dataUrl = await compressImageFile(file, COMPRESS_PRESETS.profileAvatar);
      if (dataUrl) setAvatar(dataUrl);
    } catch {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target?.result as string;
        if (base64) setAvatar(base64);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handleSave = useCallback(async () => {
    const pickupTrim = pickup.trim().slice(0, PICKUP_MAX);
    let av =
      avatar || (isServer ? "" : config?.userProfile?.avatar || "");
    if (av.length > AVATAR_CLIENT_MAX) {
      showToast(t.profile.avatarTooLarge!);
      return;
    }

    const cooldownSec = Math.max(
      0,
      Math.floor(Number(config?.profileEditCooldownSeconds ?? 0)),
    );
    if (profileCompleted && cooldownSec > 0) {
      const rem = getProfileEditCooldownRemainingMs(cooldownSec);
      if (rem > 0) {
        showToast(
          formatProfileEditCooldownMessage(
            t.profile.profileEditCooldownWait!,
            rem,
          ),
        );
        return;
      }
    }

    setSaving(true);
    try {
      const displayName =
        name.trim() ||
        (isServer ? "" : config?.userProfile?.name || "") ||
        t.profile.defaultDisplayNameFallback!;
      const phoneTrim = phone.trim();

      const updated = {
        ...config,
        userProfile: {
          ...(config?.userProfile || {}),
          name: displayName,
          avatar: av,
          phone: phoneTrim,
          pickupAddress: pickupTrim,
        },
      };
      saveConfig(updated);

      let cloudSyncSucceeded: boolean | null = null; // null = 未尝试云同步
      if (userId && isServer) {
        try {
          const backendCfg = config?.backendProxyConfig;
          const url = String(backendCfg?.supabaseUrl || "").trim();
          const anon = String(backendCfg?.supabaseAnonKey || "").trim();
          /** 与 getSupabaseBrowserClient 一致：只要 URL/anon 有效且未显式关闭 enabled，即尝试 POST /profile（避免合并配置丢 enabled 导致只存本地） */
          const canPostProfile =
            !!url &&
            !url.includes("your-") &&
            !!anon &&
            backendCfg?.enabled !== false;

          if (canPostProfile) {
            const token = await getSessionAccessTokenForEdge();
            if (!token) {
              console.warn("[ProfileDetail] No access token — skip cloud profile sync");
              showToast(t.profile.profileCloudSyncFailed!);
              cloudSyncSucceeded = false;
            } else {
              const url =
                `${String(backendCfg?.supabaseUrl || "").replace(/\/+$/, "")}/functions/v1/${(backendCfg?.edgeFunctionName || "server").replace(/^\//, "")}/profile`;
              const payload: Record<string, string> = {
                displayName,
                phone: phoneTrim,
                pickupAddress: pickupTrim,
              };
              if (
                av &&
                (av.startsWith("http://") ||
                  av.startsWith("https://") ||
                  (av.startsWith("data:image/") &&
                    av.length <= AVATAR_DATA_URL_EDGE_MAX))
              ) {
                payload.avatarUrl = av;
              }
              const res = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(backendCfg?.supabaseAnonKey
                    ? { apikey: backendCfg.supabaseAnonKey }
                    : {}),
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(payload),
              });
              if (res.ok) {
                onRemoteProfileSaved?.();
                cloudSyncSucceeded = true;
              } else {
                const errJson = (await res.json().catch(() => ({}))) as {
                  error?: string;
                  retryAfterSeconds?: number;
                };
                let detail = (errJson.error || `${res.status}`).trim();
                if (
                  res.status === 429 &&
                  typeof errJson.retryAfterSeconds === "number" &&
                  errJson.retryAfterSeconds > 0
                ) {
                  showToast(
                    formatProfileEditCooldownMessage(
                      t.profile.profileEditCooldownWait!,
                      errJson.retryAfterSeconds * 1000,
                    ),
                  );
                } else {
                  showToast(
                    detail
                      ? `${t.profile.profileCloudSyncFailed!} (${detail})`
                      : t.profile.profileCloudSyncFailed!,
                  );
                }
                cloudSyncSucceeded = false;
              }
            }
          }
        } catch (e) {
          console.warn("[ProfileDetail] Failed to save profile to cloud", e);
          showToast(t.profile.profileCloudSyncFailed!);
          cloudSyncSucceeded = false;
        }
      }

      if (cloudSyncSucceeded === true) {
        showToast(
          t.profile.profileSavedSynced || t.profile.profileUpdated!,
        );
      } else if (cloudSyncSucceeded === false) {
        /* 失败提示已在上方 */
      } else {
        showToast(t.profile.profileSavedLocalOnly!);
      }

      if (
        profileCompleted &&
        cooldownSec > 0 &&
        cloudSyncSucceeded !== false
      ) {
        recordProfileEditCooldownSave();
      }
    } catch (err) {
      console.error("[ProfileDetail] Save error:", err);
    } finally {
      setSaving(false);
    }
  }, [
    pickup,
    avatar,
    config,
    name,
    phone,
    saveConfig,
    showToast,
    t,
    userId,
    isServer,
    onRemoteProfileSaved,
    profileCompleted,
  ]);

  const handleCopyId = useCallback(() => {
    if (userId) {
      navigator.clipboard?.writeText(userId).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }, [userId]);

  return (
    <SecondaryView
      onClose={onClose}
      title={t.profile.editProfile!}
      showTitle={true}
    >
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      <div className="p-4 space-y-6">
        <div className="flex flex-col items-center pt-4">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
            className="hidden"
          />
          <div className="relative">
            <div className="relative h-24 w-24 overflow-hidden rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-xl ring-4 ring-emerald-100">
              {avatar ? (
                <img
                  src={avatar}
                  alt={t.profile.profileAvatarAlt || ""}
                  className="absolute inset-0 h-full w-full object-cover object-center"
                  decoding="async"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-white">
                  <span className="text-4xl leading-none" aria-hidden>
                    🌿
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="absolute -bottom-1 -right-1 w-9 h-9 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg active:scale-90 transition-transform ring-3 ring-white"
              aria-label={t.profile.changeAvatarA11y}
            >
              <Camera className="w-4 h-4 text-white" aria-hidden />
            </button>
          </div>
        </div>

        {linkedGoogleEmail ? (
          <div className="w-full bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <p className="text-xs font-medium text-gray-500 mb-2">
              {t.profile.linkedLoginTitle!}
            </p>
            <p className="text-sm text-gray-900 font-medium break-all">
              <span className="text-gray-500 font-normal">
                {t.profile.linkedLoginGoogle}{" "}
              </span>
              {linkedGoogleEmail}
            </p>
          </div>
        ) : null}

        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-500 mb-1.5 block">
              {t.profile.nickname!}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.profile.nicknamePlaceholder}
              className="w-full bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 outline-none focus:ring-2 focus:ring-emerald-300 transition-shadow"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1.5 block">
              {t.profile.phone!}
            </label>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t.profile.phonePlaceholder}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 outline-none focus:ring-2 focus:ring-emerald-300 transition-shadow"
              dir="ltr"
            />
            <p className="text-[10px] text-gray-400 mt-1 px-1">{t.profile.phoneHint!}</p>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 mb-1.5 block">
              {t.profile.pickupAddressLabel || t.profile.pickupInfo!}
            </label>
            <textarea
              value={pickup}
              onChange={(e) =>
                setPickup(e.target.value.slice(0, PICKUP_MAX))
              }
              maxLength={PICKUP_MAX}
              rows={3}
              placeholder={t.profile.pickupAddressPlaceholder}
              className="w-full bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-emerald-300 transition-shadow resize-none placeholder:text-gray-400"
            />
            <p className="text-[10px] text-gray-400 mt-1 px-1">
              {(t.profile.pickupAddressLimit || "").replace(
                "{n}",
                String(PICKUP_MAX),
              )}
            </p>
          </div>

          {userId && (
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1.5 block">
                {t.profile.userId!}
              </label>
              <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-4 py-3">
                <User className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <span className="text-sm text-gray-600 font-mono flex-1 truncate">{userId}</span>
                <button
                  type="button"
                  onClick={handleCopyId}
                  className="flex-shrink-0 active:scale-90 transition-transform"
                  aria-label={t.profile.copyCode}
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <Copy className="w-4 h-4 text-gray-400" />
                  )}
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-1 px-1">
                {isServer
                  ? t.profile.userIdServerHint!
                  : t.profile.userIdLocalHint!}
              </p>
            </div>
          )}
        </div>

        <div className="px-0 pb-4">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="w-full bg-emerald-600 text-white py-3.5 rounded-2xl font-medium shadow-lg active:bg-emerald-700 active:scale-[0.98] transition-all disabled:opacity-60 disabled:active:scale-100"
          >
            {saving
              ? t.profile.profileSaving || t.common.loading
              : t.common.save}
          </button>
        </div>
      </div>
    </SecondaryView>
  );
}
