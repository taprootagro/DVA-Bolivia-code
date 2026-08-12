import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense, startTransition } from "react";
import { ScanLine, MessageSquare, LogIn, Volume2, VolumeX, Loader2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useLanguage } from "../hooks/useLanguage";
import { useChatMessages } from "./community/hooks/useChatMessages";
import { useVoiceSystem } from "./community/hooks/useVoiceSystem";
import { useMerchantBind } from "./community/hooks/useMerchantBind";
import { ChatInputBar } from "./community/ChatInputBar";
import { ChatPeerAvatar } from "./community/ChatPeerAvatar";
import { MessageBubble } from "./community/MessageBubble";
import { ImageViewer } from "./community/ImageViewer";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useEdgeProfile } from "../hooks/useEdgeProfile";
import { StoreCommunityShell } from "./community/StoreCommunityShell";
import { useCommunityRoleTransition } from "./community/hooks/useCommunityRoleTransition";
import { SkeletonScreen } from "./SkeletonScreen";
import { useAppBadge } from "../hooks/useAppBadge";
import { setChatUnreadCount } from "../utils/storeChatUnread";
import { useIsCommunityActive } from "../utils/chatTabActive";
import { type ChatMessage } from "../services/ChatProxyService";
import { isUserLoggedIn, getUserId } from "../utils/auth";
import { readEdgeProfileCache } from "../utils/edgeProfileCache";
import { MockModeBanner } from "./MockModeBanner";
import { isProductionBuild } from "../utils/productionGuard";
import { chatService } from "../services/ChatProxyService";
import {
  readCommunityRoleCache,
  writeCommunityRoleCache,
  clearStoreShellState,
} from "../utils/chatTabPersistence";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

// ---- 按需加载重型弹窗组件 ----
const LazyCallDialog = lazy(() =>
  import("./CallDialog").then((m) => ({ default: m.CallDialog }))
);
const LazyMerchantBindActionSheet = lazy(() =>
  import("./community/MerchantBindActionSheet").then((m) => ({
    default: m.MerchantBindActionSheet,
  }))
);

// Re-use ChatMessage type from service, alias for backward compatibility
type Message = ChatMessage;

// ============================================================================
// Login Gate Wrapper — separates login check from chat hooks
// ============================================================================
export function CommunityPage() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { config } = useConfigContext();
  const { appRole, loading: profileLoading, error: profileError } = useEdgeProfile();

  const loggedIn = isUserLoggedIn();
  const userId = getUserId();

  useEffect(() => {
    if (!userId || profileError) return;
    const mode = appRole === "distributor" ? "distributor" : "farmer";
    const prevCached = readCommunityRoleCache(userId);
    if (prevCached && prevCached !== mode) {
      clearStoreShellState();
    }
    if (profileLoading) return;
    writeCommunityRoleCache(userId, mode);
  }, [userId, profileLoading, profileError, appRole]);

  const edgeCached =
    userId && readEdgeProfileCache()?.userId === userId
      ? readEdgeProfileCache()
      : null;
  const communityCached = userId ? readCommunityRoleCache(userId) : null;
  const showLoadingGate =
    profileLoading && communityCached == null && edgeCached == null;

  const fallbackStore = config?.communityUiMode === "store";
  const resolvedDistributor = profileError
    ? fallbackStore
    : appRole === "distributor";
  const targetMode = resolvedDistributor ? "distributor" : "farmer";

  const roleTransitionEnabled = !!userId && loggedIn && !showLoadingGate;
  const { displayMode, transitioning, chatReady } = useCommunityRoleTransition(
    targetMode,
    roleTransitionEnabled,
    userId,
  );

  if (!loggedIn || !userId) {
    return (
      <div className="flex flex-col h-full bg-gradient-to-b from-emerald-50 to-white items-center justify-center px-8">
        <div className="w-full max-w-xs text-center space-y-6">
          <div className="w-20 h-20 mx-auto bg-emerald-100 rounded-full flex items-center justify-center">
            <MessageSquare className="w-10 h-10 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-gray-800 mb-2" style={{ fontSize: 'clamp(16px, 4.5vw, 20px)' }}>
              {t.community.loginRequired || "Login Required"}
            </h2>
            <p className="text-gray-500" style={{ fontSize: 'clamp(12px, 3.2vw, 14px)' }}>
              {t.community.loginToChat || "Please log in to start chatting with your merchant"}
            </p>
          </div>
          <button
            onClick={() => startTransition(() => { void navigate("/login"); })}
            className="w-full bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl py-3 font-medium shadow-lg active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
            style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}
          >
            <LogIn className="w-4 h-4" />
            {t.community.goToLogin || "Go to Login"}
          </button>
        </div>
      </div>
    );
  }

  if (showLoadingGate) {
    return (
      <div className="flex flex-col h-full min-h-0 overflow-hidden bg-gray-50">
        <SkeletonScreen />
      </div>
    );
  }

  const transitionLabel =
    t.community.switchingRoleMode ||
    (targetMode === "distributor"
      ? "Switching to store chat…"
      : "Switching to farmer chat…");

  return (
    <div className="relative flex flex-col h-full min-h-0 overflow-hidden">
      {transitioning ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/90 backdrop-blur-sm">
          <Loader2 className="w-8 h-8 text-emerald-600 animate-spin mb-3" />
          <p className="text-sm text-gray-600 px-6 text-center">{transitionLabel}</p>
        </div>
      ) : null}
      {chatReady && displayMode === "distributor" ? (
        <StoreCommunityShell storeUserId={userId} />
      ) : null}
      {chatReady && displayMode === "farmer" ? <CommunityChat /> : null}
    </div>
  );
}

// ============================================================================
// Virtuoso Header / Footer — 提升到模块级避免每次渲染重建组件引用
// ============================================================================
function VirtuosoFooter() {
  return <div className="h-2" />;
}

// ============================================================================
// Chat UI — only rendered after login (safe to use hooks)
// ============================================================================
function CommunityChat() {
  const { t, isRTL } = useLanguage();
  const { config, saveConfig } = useConfigContext();
  // 聊天页状态栏颜色与顶部绿色一致
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute('content') || '#059669';
    meta?.setAttribute('content', '#059669');
    return () => { meta?.setAttribute('content', prev); };
  }, []);

  // Cross-device rehydrate: if local config has no bound merchant, pull the
  // latest farmer_merchant_bindings row from Supabase (RLS isolates per farmer).
  useEffect(() => {
    if (!config) return;
    const cc = config.chatContact;
    if (cc?.merchantUserId && cc?.channelId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { findLatestBinding } = await import("../services/farmerBindingRepo");
        const latest = await findLatestBinding();
        if (cancelled || !latest) return;
        saveConfig({
          ...config,
          chatContact: {
            ...config.chatContact,
            merchantUserId: latest.merchantUserId,
            channelId: latest.channelId,
            name: latest.name || config.chatContact.name,
            avatar: latest.avatar || config.chatContact.avatar,
            subtitle: "",
            boundAt: Date.parse(latest.createdAt) || Date.now(),
          },
        });
      } catch (e) {
        console.warn("[CommunityChat] rehydrate binding", e);
      }
    })();
    return () => { cancelled = true; };
  }, [config, saveConfig]);

  const {
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
  } = useMerchantBind({ isStoreShell: false });

  const communityActive = useIsCommunityActive();
  const communityActiveRef = useRef(communityActive);
  communityActiveRef.current = communityActive;
  const [unread, setUnread] = useState(0);

  const onDirectoryActivity = useCallback(
    (args: { preview: string; incoming: boolean }) => {
      if (args.incoming && !communityActiveRef.current) {
        setUnread((n) => n + 1);
      }
    },
    [],
  );

  const onResumeCatchUp = useCallback(
    (missedIncoming: ChatMessage[]) => {
      if (communityActiveRef.current || missedIncoming.length === 0) return;
      setUnread((n) => n + missedIncoming.length);
    },
    [],
  );

  const {
    chatMessages,
    firstItemIndex,
    proxyMode,
    realtimeError,
    currentUserId,
    isSending,
    sendTextMessage,
    sendVoiceMessage,
    sendImageMessage,
    retryFailedMessage,
    loadOlder,
    hasMoreOlder,
  } = useChatMessages(config, { onDirectoryActivity, onResumeCatchUp });

  const showChatMockBanner = isProductionBuild() && proxyMode === "mock";
  const callsEnabled = !showChatMockBanner && chatService.mode === "backend";

  useEffect(() => {
    if (communityActive) {
      setUnread(0);
    }
  }, [communityActive]);

  useEffect(() => {
    setChatUnreadCount(unread);
    return () => setChatUnreadCount(0);
  }, [unread]);

  // Web/PWA：OS 角标；原生由推送 payload 驱动
  useAppBadge(unread);

  // D8: Virtuoso startReached —— 上滑到顶时拉更早 30 条；hasMoreOlder=false 时短路
  const handleStartReached = useCallback(() => {
    if (!hasMoreOlder) return;
    void loadOlder();
  }, [loadOlder, hasMoreOlder]);


  const {
    playingVoiceId,
    ttsEnabled,
    toggleTts,
    toggleVoicePlay,
    handleTextMsgClick,
  } = useVoiceSystem(chatMessages, currentUserId);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scanAlbumInputRef = useRef<HTMLInputElement>(null);

  // 通话状态
  const [showCallDialog, setShowCallDialog] = useState(false);
  const [callType, setCallType] = useState<"audio" | "video">("audio");
  const [callStatus, setCallStatus] = useState<"calling" | "connected" | "ended">("calling");
  const [viewingImage, setViewingImage] = useState<string | null>(null);

  // 懒加载弹窗是否曾被触发过（加载后保持 mounted 以缓存 chunk）
  const [merchantBindEverShown, setMerchantBindEverShown] = useState(false);
  const [callDialogEverShown, setCallDialogEverShown] = useState(false);

  // 固定单个联系人 - 从配置获取（useMemo 稳定引用）
  const contact = useMemo(() => ({
    id: config?.chatContact?.merchantUserId || "",
    name: config?.chatContact?.name || "",
    avatar: config?.chatContact?.avatar || "",
    imUserId: config?.chatContact?.merchantUserId || "",
    imProvider: "supabase",
    online: true,
  }), [config?.chatContact?.merchantUserId, config?.chatContact?.name, config?.chatContact?.avatar]);

  // 扫一扫 → 域名验证 → 绑定商家联系人
  const handleQRScanResult = useCallback((qrText: string) => {
    setShowScanner(false);
    processScanResult(qrText);
  }, [setShowScanner, processScanResult]);

  // 稳定化 onImageClick 回调
  const handleImageClick = useCallback((src: string) => {
    setViewingImage(src);
  }, []);

  // 稳定化 onCall 回调（避免 ChatInputBar 不必要重渲染）
  const handleCall = useCallback((type: "audio" | "video") => {
    if (!callsEnabled) return;
    setCallType(type);
    setCallStatus("calling");
    setShowCallDialog(true);
    setCallDialogEverShown(true);
  }, [callsEnabled]);

  // 打开商户绑定 ActionSheet
  const handleOpenScanSheet = useCallback(() => {
    setShowScanActionSheet(true);
    setMerchantBindEverShown(true);
  }, [setShowScanActionSheet]);

  // ---- Virtuoso 渲染稳定化 ----
  // 简单的顶部间距
  const VirtuosoHeader = useMemo(() => {
    return function Header() {
      return <div className="h-2" />;
    };
  }, []);

  // Virtuoso components 对象引用稳定化
  const virtuosoComponents = useMemo(() => ({
    Header: VirtuosoHeader,
    Footer: VirtuosoFooter,
  }), [VirtuosoHeader]);

  // itemContent 回调：只在核心依赖变化时重建
  const renderItem = useCallback((_index: number, msg: Message) => (
    <div className="pb-2.5">
      <MessageBubble
        msg={msg}
        currentUserId={currentUserId}
        isPlaying={playingVoiceId === msg.id}
        isRTL={isRTL}
        onTogglePlay={toggleVoicePlay}
        onTextClick={handleTextMsgClick}
        onImageClick={handleImageClick}
        onRetryFailed={retryFailedMessage}
      />
    </div>
  ), [currentUserId, playingVoiceId, isRTL, toggleVoicePlay, handleTextMsgClick, handleImageClick, retryFailedMessage]);

  // 判断是否需要渲染弹窗层（按需加载触发条件）
  const needsMerchantBind = merchantBindEverShown || showScanner || showScanActionSheet || scanResult !== null;
  const needsCallDialog = callDialogEverShown || showCallDialog;

  return (
    <div className="flex flex-col h-full min-h-0 bg-gradient-to-b from-emerald-50 to-white">
      {/* 全屏图片查看器 */}
      {viewingImage && (
        <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
      )}

      {/* 商户绑定：扫码器 + 扫码结果弹窗 + Action Sheet (按需加载) */}
      {needsMerchantBind && (
        <Suspense fallback={null}>
          <LazyMerchantBindActionSheet
            showScanner={showScanner}
            setShowScanner={setShowScanner}
            showScanActionSheet={showScanActionSheet}
            scanSheetAnim={scanSheetAnim}
            closeScanActionSheet={closeScanActionSheet}
            scanAlbumInputRef={scanAlbumInputRef}
            handleScanAlbumFile={handleScanAlbumFile}
            scanAlbumScanning={scanAlbumScanning}
            scanAlbumError={scanAlbumError}
            scanResult={scanResult}
            setScanResult={setScanResult}
            confirmBindMerchant={confirmBindMerchant}
            handleQRScanResult={handleQRScanResult}
          />
        </Suspense>
      )}

      {/* 通话弹窗 (按需加载) */}
      {needsCallDialog && (
        <Suspense fallback={null}>
          <LazyCallDialog
            isOpen={showCallDialog}
            onClose={() => setShowCallDialog(false)}
            contactName={contact.name}
            contactAvatar={contact.avatar}
            callType={callType}
            callStatus={callStatus}
          />
        </Suspense>
      )}

      {/* 顶部绿色区域 */}
      <div className="bg-[#059669] px-4 pb-4 flex-shrink-0 shadow-lg safe-top" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
        <div className="flex items-center gap-3">
          <button className="flex-shrink-0 active:opacity-80 transition-all active:scale-95">
            <div className="relative">
              <ChatPeerAvatar avatar={contact.avatar} size="lg" className="ring-2 ring-white shadow-xl" />
              {contact.online && (
                <div className={`absolute -bottom-0.5 ${isRTL ? '-left-0.5' : '-right-0.5'}`}>
                  <div className="relative">
                    <div className="w-4 h-4 bg-green-400 rounded-full border-2 border-white shadow-md"></div>
                    <div className="absolute inset-0 w-4 h-4 bg-green-400 rounded-full animate-ping opacity-50"></div>
                  </div>
                </div>
              )}
            </div>
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-white font-bold text-lg drop-shadow-sm truncate">{contact.name}</h2>
          </div>
          <div className="flex-shrink-0 flex items-center gap-0.5">
            {/* 统一语音播放控制 */}
            <button
              className={`w-10 h-10 flex items-center justify-center active:scale-95 transition-all rounded-xl ${ttsEnabled ? 'active:bg-white/20' : 'bg-white/20 active:bg-white/30'}`}
              onClick={toggleTts}
            >
              {ttsEnabled
                ? <Volume2 className="w-5 h-5 text-white" strokeWidth={2.5} />
                : <VolumeX className="w-5 h-5 text-white" strokeWidth={2.5} />
              }
            </button>
            {/* 扫码按钮 */}
            <button className="w-10 h-10 flex items-center justify-center active:scale-95 transition-all rounded-xl active:bg-white/20" onClick={handleOpenScanSheet}>
              <ScanLine className="w-5 h-5 text-white" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>

      {/* 聊天区域 */}
      <div className="flex-1 bg-white rounded-t-3xl -mt-4 flex flex-col overflow-hidden min-h-0 shadow-2xl">
        {showChatMockBanner && <MockModeBanner feature="chat" />}
        {realtimeError && (
          <div className="px-3 py-2 bg-red-50 border-b border-red-100 text-red-800 text-xs">
            {realtimeError}
          </div>
        )}
        <div className="flex-1 px-4 py-4 min-h-0">
          <Virtuoso
            ref={virtuosoRef}
            data={chatMessages}
            firstItemIndex={firstItemIndex}
            computeItemKey={(_index, msg) => msg.id}
            initialTopMostItemIndex={Math.max(0, chatMessages.length - 1)}
            components={virtuosoComponents}
            itemContent={renderItem}
            followOutput="smooth"
            alignToBottom
            startReached={handleStartReached}
          />
        </div>

        {/* 底部输入栏 */}
        <ChatInputBar
          onSendText={sendTextMessage}
          onSendVoice={sendVoiceMessage}
          onSendImage={sendImageMessage}
          onCall={handleCall}
          isSending={isSending}
          callsEnabled={callsEnabled}
          adjoinDock
        />
      </div>
    </div>
  );
}

// 默认导出用于懒加载
export default CommunityPage;