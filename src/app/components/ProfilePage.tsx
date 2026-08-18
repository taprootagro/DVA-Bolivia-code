import { useState, useEffect, useRef, useCallback, useMemo, startTransition } from "react";
import {
  MapPin,
  Edit,
  Settings,
  FileText,
  Package,
  CreditCard,
  Calendar,
  Info,
  QrCode,
  ChevronRight,
  LogIn,
  User,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { useLanguage } from "../hooks/useLanguage";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useEdgeProfile } from "../hooks/useEdgeProfile";
import { storageGet } from "../utils/safeStorage";
import {
  isUserLoggedIn,
  getUserId,
  isServerAssignedId,
  TAPROOT_AUTH_CHANGE_EVENT,
} from "../utils/auth";
import { kvGetEncrypted } from "../utils/db";
import { PickupAddressEdit } from "./PickupAddressEdit";
import { AllOrdersPage } from "./AllOrdersPage";
import { PendingReceiptPage } from "./PendingReceiptPage";
import { PendingPaymentPage } from "./PendingPaymentPage";
import { InvoiceRecordsPage } from "./InvoiceRecordsPage";
import { AbnormalFeedbackPage } from "./AbnormalFeedbackPage";
import { AboutUsPage } from "./AboutUsPage";
import { ProfileDetailPage } from "./ProfileDetailPage";

import ProfileQRCard from "./ProfileQRCard";
import { StoreBindQRCard } from "./StoreBindQRCard";
import { PROFILE_GATE_DISMISSED_SESSION_KEY } from "../constants";
import {
  armProfileGateSkipAutoOnce,
  consumeProfileGateSkipAutoOnce,
} from "../utils/profileGateSkip";
import {
  formatProfileEditCooldownMessage,
  getProfileEditCooldownRemainingMs,
} from "../utils/profileEditCooldown";

export function ProfilePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const onboarding = searchParams.get("onboarding") === "1";
  const { t } = useLanguage();
  const { config } = useConfigContext();
  const {
    appRole,
    dbProfile,
    profileCompleted,
    displayName: edgeDisplayName,
    phone: edgePhone,
    pickupAddress: edgePickup,
    avatarUrl: edgeAvatarUrl,
    loading: profileLoading,
    error: profileError,
    refresh: refreshEdgeProfile,
  } = useEdgeProfile();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showAddressEdit, setShowAddressEdit] = useState(false);
  const [showAllOrders, setShowAllOrders] = useState(false);
  const [showPendingReceipt, setShowPendingReceipt] = useState(false);
  const [showPendingPayment, setShowPendingPayment] = useState(false);
  const [showInvoiceRecords, setShowInvoiceRecords] = useState(false);
  const [showAbnormalFeedback, setShowAbnormalFeedback] = useState(false);
  const [showAboutUs, setShowAboutUs] = useState(false);
  const [showProfileDetail, setShowProfileDetail] = useState(false);
  const [showQRCard, setShowQRCard] = useState(false);
  const [showStoreBindQR, setShowStoreBindQR] = useState(false);
  const [pickupAddress, setPickupAddress] = useState("");
  const [profileCooldownToast, setProfileCooldownToast] = useState<string | null>(null);

  /** 用户关闭资料页后，在资料仍不完整时不再因 profileLoading 刷新而反复自动打开。 */
  const profileDetailDismissedRef = useRef(false);
  /** 仅当 profileCompleted 从 false→true 时自动关编辑层；若已为 true，用户点头像打开不应被立刻关掉。 */
  const profileCompletedPrevRef = useRef<boolean | undefined>(undefined);

  const userId = getUserId();
  /** 服务端账号登录时不得用出厂/模板 `config.userProfile` 兜底，否则会显示 chat.json 里的占位资料。 */
  const serverBackedProfile = isUserLoggedIn() && isServerAssignedId();
  const fallbackStore = config?.communityUiMode === "store";
  const isStoreMode =
    profileLoading || profileError
      ? fallbackStore
      : appRole === "distributor";

  const displayPhone = (
    serverBackedProfile
      ? edgePhone
      : (edgePhone || config?.userProfile?.phone || "")
  ).trim();

  const backendOk =
    config?.backendProxyConfig?.enabled === true &&
    !!(config.backendProxyConfig.supabaseUrl || "").trim() &&
    isServerAssignedId();

  /** 仅当服务端判定资料未完善时引导编辑；不再依赖 ?onboarding=1（避免每次 OAuth 都弹层） */
  const gateIncomplete =
    isUserLoggedIn() &&
    backendOk &&
    !profileLoading &&
    !profileError &&
    !profileCompleted;

  const headerName = serverBackedProfile
    ? (edgeDisplayName.trim() ||
        (profileLoading ? String(t.common.loading || "").trim() : "") ||
        t.profile.defaultDisplayNameFallback)
    : (edgeDisplayName || config?.userProfile?.name || "").trim() ||
      t.profile.defaultDisplayNameFallback;
  const headerAvatar = serverBackedProfile
    ? edgeAvatarUrl
    : edgeAvatarUrl || config?.userProfile?.avatar || "";

  const profileEdgeSnapshot = useMemo(
    () => ({
      displayName: edgeDisplayName,
      phone: edgePhone,
      pickupAddress: edgePickup,
      avatarUrl: edgeAvatarUrl,
    }),
    [edgeDisplayName, edgePhone, edgePickup, edgeAvatarUrl],
  );
  const displayPickup =
    !profileLoading && (edgePickup || "").trim()
      ? edgePickup
      : serverBackedProfile
        ? pickupAddress || ""
        : pickupAddress || (config?.userProfile?.pickupAddress || "");

  useEffect(() => {
    const syncLoggedIn = () => setIsLoggedIn(isUserLoggedIn());
    syncLoggedIn();
    window.addEventListener(TAPROOT_AUTH_CHANGE_EVENT, syncLoggedIn);
    const savedAddress = storageGet("pickup-address");
    if (savedAddress) setPickupAddress(savedAddress);
    kvGetEncrypted("pickup-address").then((addr) => {
      if (addr) setPickupAddress(addr);
    }).catch(() => {});
    return () =>
      window.removeEventListener(TAPROOT_AUTH_CHANGE_EVENT, syncLoggedIn);
  }, []);

  useEffect(() => {
    if (!profileLoading && (edgePickup || "").trim()) {
      setPickupAddress(edgePickup);
    }
  }, [edgePickup, profileLoading]);

  useEffect(() => {
    if (profileCompleted) {
      profileDetailDismissedRef.current = false;
      try {
        sessionStorage.removeItem(PROFILE_GATE_DISMISSED_SESSION_KEY);
      } catch {
        /* ignore */
      }
    }
  }, [profileCompleted]);

  useEffect(() => {
    if (!isUserLoggedIn() || !gateIncomplete || profileLoading) return;
    if (profileDetailDismissedRef.current) return;
    try {
      if (sessionStorage.getItem(PROFILE_GATE_DISMISSED_SESSION_KEY)) return;
    } catch {
      /* ignore */
    }
    if (consumeProfileGateSkipAutoOnce()) return;
    setShowProfileDetail(true);
  }, [gateIncomplete, profileLoading]);

  useEffect(() => {
    const wasIncomplete = profileCompletedPrevRef.current === false;
    profileCompletedPrevRef.current = profileCompleted;
    if (profileCompleted && wasIncomplete && showProfileDetail) {
      setShowProfileDetail(false);
    }
  }, [profileCompleted, showProfileDetail]);

  const onProfileDetailClose = useCallback(() => {
    profileDetailDismissedRef.current = true;
    try {
      sessionStorage.setItem(PROFILE_GATE_DISMISSED_SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
    setShowProfileDetail(false);
  }, []);

  /** 从个人中心进设置：arm skip，并收起资料层，避免 keep-alive / 历史返回时闪一下编辑页 */
  const goToSettings = useCallback(() => {
    startTransition(() => {
      armProfileGateSkipAutoOnce();
      setShowProfileDetail(false);
      void navigate("/home/settings", {
        state: { settingsFrom: "/home/profile" },
      });
    });
  }, [navigate]);

  const tryOpenProfileDetail = useCallback(() => {
    const cooldownSec = Math.max(
      0,
      Math.floor(Number(config?.profileEditCooldownSeconds ?? 0)),
    );
    if (profileCompleted && cooldownSec > 0) {
      const rem = getProfileEditCooldownRemainingMs(cooldownSec);
      if (rem > 0) {
        const msg = formatProfileEditCooldownMessage(
          t.profile.profileEditCooldownWait ||
            "Please wait {minutes} min {seconds} sec before editing again.",
          rem,
        );
        setProfileCooldownToast(msg);
        setTimeout(() => setProfileCooldownToast(null), 2500);
        return;
      }
    }
    setShowProfileDetail(true);
  }, [config?.profileEditCooldownSeconds, profileCompleted, t.profile.profileEditCooldownWait]);

  /** 去掉历史 URL 中的 ?onboarding=1，避免与「仅首次完善资料」逻辑混淆 */
  useEffect(() => {
    if (!onboarding) return;
    navigate("/home/profile", { replace: true });
  }, [onboarding, navigate]);

  const menuItems = [
    {
      section: "",
      items: [
        { icon: FileText, label: t.profile.allOrders, color: "text-blue-600", action: () => setShowAllOrders(true) },
        { icon: Package, label: t.profile.pendingReceipt, color: "text-green-600", action: () => setShowPendingReceipt(true) },
        { icon: CreditCard, label: t.profile.pendingPayment, color: "text-orange-600", action: () => setShowPendingPayment(true) },
        { icon: Calendar, label: t.profile.invoiceRecords, color: "text-purple-600", action: () => setShowInvoiceRecords(true) },
        { icon: Info, label: t.profile.abnormalFeedback, color: "text-red-600", action: () => setShowAbnormalFeedback(true) },
      ],
    },
    {
      section: "",
      items: [
        { icon: Settings, label: t.profile.settings, color: "text-gray-600", action: goToSettings },
        { icon: Info, label: t.profile.aboutUs, color: "text-emerald-600", action: () => setShowAboutUs(true) },
      ],
    },
  ];

  // 未登录
  if (!isLoggedIn) {
    return (
      <div className="pb-safe-nav min-h-full relative" style={{ backgroundColor: 'var(--app-bg)' }}>
        <div className="absolute top-0 left-0 right-0 h-60 bg-emerald-600 rounded-b-3xl shadow-lg">
          <div className="absolute top-8 ltr:right-8 rtl:left-8 w-20 h-20 bg-white/10 rounded-full blur-2xl"></div>
          <div className="absolute bottom-8 ltr:left-8 rtl:right-8 w-24 h-24 bg-white/10 rounded-full blur-3xl"></div>
        </div>
        <div className="relative z-10 px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top, 8px) + 16px)' }}>
          <div className="flex flex-col items-center mb-8">
            {/* 与底部 Dock「我的」同形：lucide User，样式对齐 Layout.tsx 选中态 */}
            <div
              className="mb-3 flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-white shadow-lg ring-4 ring-white/30"
              aria-hidden
            >
              <User
                className="h-12 w-12 shrink-0"
                style={{ color: "#059669" }}
                strokeWidth={2.2}
              />
            </div>
            <p className="text-white/90 text-sm">{t.profile.loginPrompt}</p>
          </div>
          <div className="bg-white rounded-3xl p-6 shadow-2xl text-center">
            <button
              onClick={() => startTransition(() => { void navigate("/login"); })}
              className="w-full bg-emerald-600 text-white py-3.5 rounded-2xl active:bg-emerald-700 transition-colors duration-150 flex items-center justify-center gap-2 font-medium shadow-lg"
            >
              <LogIn className="w-5 h-5" />
              {t.common.login}
            </button>
          </div>
          <div className="mt-4">
            <div className="bg-white rounded-2xl overflow-hidden shadow-sm">
              <button
                onClick={goToSettings}
                className="w-full px-4 py-3 flex items-center justify-between active:bg-emerald-50 transition-colors duration-150"
              >
                <div className="flex items-center gap-3">
                  <Settings className="w-5 h-5 text-gray-600" />
                  <span className="text-sm text-gray-800">{t.profile.settings}</span>
                </div>
                <ChevronRight className="w-5 h-5 text-emerald-600" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 已登录
  return (
    <div className="pb-safe-nav min-h-full" style={{ backgroundColor: 'var(--app-bg)' }}>
      {profileCooldownToast ? (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-lg max-w-[90vw] text-center">
          {profileCooldownToast}
        </div>
      ) : null}
      {showProfileDetail && (
        <ProfileDetailPage
          onClose={onProfileDetailClose}
          dbProfile={dbProfile}
          edgeSnapshot={profileEdgeSnapshot}
          profileLoading={profileLoading}
          profileError={profileError}
          profileCompleted={profileCompleted}
          onRemoteProfileSaved={() => {
            queueMicrotask(() => {
              void refreshEdgeProfile();
            });
          }}
        />
      )}
      {showAddressEdit && (
        <PickupAddressEdit
          initialAddress={displayPickup}
          onClose={() => setShowAddressEdit(false)}
          onSave={(newAddress) => setPickupAddress(newAddress)}
          onRemoteSynced={() => void refreshEdgeProfile()}
        />
      )}
      {showAllOrders && <AllOrdersPage onClose={() => setShowAllOrders(false)} />}
      {showPendingReceipt && <PendingReceiptPage onClose={() => setShowPendingReceipt(false)} />}
      {showPendingPayment && <PendingPaymentPage onClose={() => setShowPendingPayment(false)} />}
      {showInvoiceRecords && <InvoiceRecordsPage onClose={() => setShowInvoiceRecords(false)} />}
      {showAbnormalFeedback && <AbnormalFeedbackPage onClose={() => setShowAbnormalFeedback(false)} />}
      {showAboutUs && <AboutUsPage onClose={() => setShowAboutUs(false)} />}

      {/* 懒加载二维码卡片 */}
      {showQRCard && !isStoreMode && (
        <ProfileQRCard
          onClose={() => setShowQRCard(false)}
          userId={userId || ""}
          name={headerName}
        />
      )}
      {showStoreBindQR && isStoreMode && userId && (
        <StoreBindQRCard onClose={() => setShowStoreBindQR(false)} userId={userId} />
      )}

      {/* 绿色头部 — 头像 + 网名 + 二维码 水平对齐 */}
      <div className="bg-emerald-600 px-4 pb-5 rounded-b-3xl shadow-lg" style={{ paddingTop: 'calc(env(safe-area-inset-top, 8px) + 16px)' }}>
        <div className="flex items-center gap-3">
          {/* 头像 — 点击进入编辑 */}
          <button
            type="button"
            onClick={tryOpenProfileDetail}
            className="relative w-14 h-14 shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 p-0 shadow-lg ring-4 ring-white/20 active:opacity-80 transition-opacity border-0"
          >
            {headerAvatar ? (
              <img
                src={headerAvatar}
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-center"
                decoding="async"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-white">
                <span className="text-2xl">🌿</span>
              </div>
            )}
          </button>

          {/* 网名 — 点击进入编辑 */}
          <button
            onClick={tryOpenProfileDetail}
            className="flex-1 min-w-0 text-start active:opacity-80 transition-opacity"
          >
            <h2 className="text-xl font-semibold text-white truncate">
              {headerName}
            </h2>
            {displayPhone ? (
              <p className="mt-0.5 text-sm text-white/85 truncate" dir="ltr">
                {displayPhone}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-white/65 truncate">{t.profile.addPhoneHint}</p>
            )}
          </button>

          {/* 二维码：农户=用户 ID；门店=农户扫码绑定短链 */}
          <button
            onClick={() =>
              isStoreMode ? setShowStoreBindQR(true) : setShowQRCard(true)
            }
            className="flex-shrink-0 text-white active:scale-95 transition-transform duration-150 bg-white/10 p-2.5 rounded-full backdrop-blur-sm"
            aria-label={isStoreMode ? (t.profile.storeBindQrTitle ?? "Store bind QR") : (t.profile.myQRCode ?? "My QR")}
          >
            <QrCode className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* 提货地点卡片 */}
      <div className="px-4 mt-4">
        <div className="bg-white rounded-2xl p-3 shadow-lg">
          <div className="flex items-start gap-2">
            <MapPin className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-gray-800 mb-1.5">{t.profile.pickupInfo}</h3>
              <p className="text-xs text-gray-500 leading-relaxed line-clamp-2 break-all">{displayPickup}</p>
            </div>
            <button
              onClick={() => setShowAddressEdit(true)}
              className="text-emerald-600 active:scale-95 transition-transform duration-150 flex-shrink-0"
            >
              <Edit className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 菜单列表 */}
      <div className="px-4 mt-4 space-y-3">
        {menuItems.map((section, sectionIndex) => (
          <div key={sectionIndex} className="bg-white rounded-2xl overflow-hidden shadow-lg">
            {section.section && (
              <div className="px-4 py-2 bg-gray-50">
                <h3 className="text-sm text-gray-600">{section.section}</h3>
              </div>
            )}
            {section.items.map((item, itemIndex) => {
              const Icon = item.icon;
              return (
                <div key={itemIndex}>
                  <button
                    onClick={item.action}
                    className="w-full px-4 py-3 flex items-center justify-between active:bg-emerald-100 transition-colors duration-150 min-w-0"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Icon className={`w-5 h-5 flex-shrink-0 ${item.color}`} />
                      <span className="text-sm text-gray-800 truncate">{item.label}</span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  </button>
                  {itemIndex < section.items.length - 1 && (
                    <div className="mx-4" style={{ height: '1px', background: 'linear-gradient(to right, transparent, rgba(0,0,0,0.06), transparent)' }}></div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default ProfilePage;