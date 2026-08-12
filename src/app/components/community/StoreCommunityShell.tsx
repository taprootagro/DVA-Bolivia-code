import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  lazy,
  Suspense,
} from "react";
import {
  ScanLine,
  MessageSquare,
  Volume2,
  VolumeX,
  Users,
  ChevronLeft,
  ChevronRight,
  QrCode,
} from "lucide-react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { useLanguage } from "../../hooks/useLanguage";
import { useConfigContext } from "../../hooks/ConfigProvider";
import { useAppBadge } from "../../hooks/useAppBadge";
import { useBackHandler } from "../../hooks/useBackHandler";
import { chatService, type ChatMessage } from "../../services/ChatProxyService";
import {
  ALPHABET_INDEX,
  blockPeer,
  clearUnread,
  deleteRecentThread,
  getPeer,
  groupPeersByLetterForStore,
  removePeerAndData,
  listBlockedPeerKeys,
  listPeersSorted,
  listRecents,
  touchRecentWithPeerEnsure,
  type StorePeerRecord,
  type StoreRecentRecord,
  unblockPeer,
  isBlocked,
  peerDisplayName,
  removeLegacyDemoSupportContact,
} from "../../services/storeChatDirectory";
import { SecondaryView } from "../SecondaryView";
import { ChatInputBar } from "./ChatInputBar";
import { ChatPeerAvatar } from "./ChatPeerAvatar";
import { MessageBubble } from "./MessageBubble";
import { ImageViewer } from "./ImageViewer";
import { useChatMessages, type ChatActivePeerInput } from "./hooks/useChatMessages";
import { useVoiceSystem } from "./hooks/useVoiceSystem";
import { MockModeBanner } from "../MockModeBanner";
import { isProductionBuild } from "../../utils/productionGuard";
import { useStoreBackgroundMessages } from "./hooks/useStoreBackgroundMessages";
import { useMerchantBind } from "./hooks/useMerchantBind";
import {
  syncStorePeersFromCloud,
  subscribeStorePeerInserts,
} from "../../services/storeBindingRepo";
import { StoreBindQRCard } from "../StoreBindQRCard";
import {
  readStoreShellState,
  writeStoreShellState,
} from "../../utils/chatTabPersistence";
import { setStoreChatUnreadCount } from "../../utils/storeChatUnread";
import { toast } from "../../utils/capacitor-bridge";

const LazyMerchantBindActionSheet = lazy(() =>
  import("./MerchantBindActionSheet").then((m) => ({
    default: m.MerchantBindActionSheet,
  }))
);
const LazyCallDialog = lazy(() =>
  import("../CallDialog").then((m) => ({ default: m.CallDialog }))
);

type Message = ChatMessage;
type ShellMode = "recents" | "contacts" | "thread";

function VirtuosoFooter() {
  return <div className="h-2" />;
}

function ContactsBackCapture({ onBack }: { onBack: () => void }) {
  useBackHandler(onBack, false);
  return null;
}

interface RecentRowProps {
  title: string;
  subtitle: string;
  avatar: string;
  unread: number;
  lastMessageAt: number;
  blocked?: boolean;
  blockedLabel?: string;
  onPress: () => void;
  onLongPress: () => void;
}

function formatRecentTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return "Yesterday";
  }
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function RecentRow({
  title,
  subtitle,
  avatar,
  unread,
  lastMessageAt,
  blocked,
  blockedLabel,
  onPress,
  onLongPress,
}: RecentRowProps) {
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return (
    <button
      type="button"
      className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 active:bg-gray-50 text-left touch-manipulation select-none"
      onClick={onPress}
      onPointerDown={() => {
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          onLongPress();
        }, 550);
      }}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
    >
      <ChatPeerAvatar avatar={avatar} size="lg" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={`truncate ${unread > 0 && !blocked ? "font-bold text-gray-900" : "font-semibold text-gray-900"}`}
          >
            {title}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {lastMessageAt > 0 ? (
              <span className={`text-[11px] tabular-nums ${unread > 0 && !blocked ? "text-emerald-700 font-medium" : "text-gray-400"}`}>
                {formatRecentTime(lastMessageAt)}
              </span>
            ) : null}
            {!blocked && unread > 0 && (
              <span className="text-xs bg-red-500 text-white min-w-[1.125rem] h-[1.125rem] px-1 rounded-full flex items-center justify-center font-medium">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </div>
        </div>
        <p
          className={`text-sm truncate ${blocked ? "text-amber-700/90" : unread > 0 ? "text-gray-800 font-medium" : "text-gray-500"}`}
        >
          {blocked ? blockedLabel || "Blocked" : subtitle}
        </p>
      </div>
    </button>
  );
}

interface ContactRowProps {
  peer: StorePeerRecord;
  displayName: string;
  blocked?: boolean;
  blockedLabel?: string;
  onPress: () => void;
  onLongPress: () => void;
}

function ContactRow({ peer, displayName, blocked, blockedLabel, onPress, onLongPress }: ContactRowProps) {
  const timerRef = useRef<number | null>(null);
  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  return (
    <button
      type="button"
      className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 active:bg-gray-50 text-left touch-manipulation select-none"
      onClick={onPress}
      onPointerDown={() => {
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          onLongPress();
        }, 550);
      }}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
    >
      <ChatPeerAvatar avatar={peer.avatar} size="md" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 truncate">{displayName}</p>
        <p className={`text-xs truncate ${blocked ? "text-amber-700/90" : "text-gray-500"}`}>
          {blocked ? blockedLabel || "Blocked" : peer.subtitle || ""}
        </p>
      </div>
    </button>
  );
}

interface StoreThreadPanelProps {
  peer: StorePeerRecord;
  storeUserId: string;
  onRefreshShell: () => void;
}

function StoreThreadPanel({ peer, storeUserId, onRefreshShell }: StoreThreadPanelProps) {
  const { t, isRTL } = useLanguage();
  const { config } = useConfigContext();
  const [peerBlocked, setPeerBlocked] = useState(false);
  const peerLabel = peerDisplayName(peer, t.community.storeFarmerFallback || "Farmer");

  useEffect(() => {
    let cancelled = false;
    void isBlocked(storeUserId, peer.peerKey).then((b) => {
      if (!cancelled) setPeerBlocked(b);
    });
    return () => {
      cancelled = true;
    };
  }, [storeUserId, peer.peerKey]);

  const activePeerInput: ChatActivePeerInput = useMemo(
    () => ({
      peerKey: peer.peerKey,
      channelId: peer.channelId,
      imUserId: peer.imUserId,
      imProvider: peer.imProvider,
      name: peerLabel,
      avatar: peer.avatar,
      subtitle: peer.subtitle,
      phone: peer.phone,
      storeId: peer.storeId,
    }),
    [peer, peerLabel],
  );

  const onDirectoryActivity = useCallback(
    (args: { preview: string; incoming: boolean }) => {
      // 正在该对话内：只更新预览与时间，不增加未读（等同微信当前会话）
      void touchRecentWithPeerEnsure(storeUserId, peer, args.preview, false);
      onRefreshShell();
    },
    [storeUserId, peer, onRefreshShell],
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
  } = useChatMessages(config, {
    activePeer: activePeerInput,
    peerBlocked,
    directoryUserId: storeUserId,
    onDirectoryActivity,
  });

  // D8: Virtuoso startReached —— 上滑到顶时拉更早 30 条；hasMoreOlder=false 短路
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
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [showCallDialog, setShowCallDialog] = useState(false);
  const [callType, setCallType] = useState<"audio" | "video">("audio");
  const [callStatus, setCallStatus] = useState<"calling" | "connected" | "ended">("calling");
  const [callDialogEverShown, setCallDialogEverShown] = useState(false);

  const VirtuosoHeader = useMemo(
    () =>
      function Header() {
        return <div className="h-2" />;
      },
    [],
  );

  const virtuosoComponents = useMemo(
    () => ({
      Header: VirtuosoHeader,
      Footer: VirtuosoFooter,
    }),
    [VirtuosoHeader],
  );

  const handleImageClick = useCallback((src: string) => {
    setViewingImage(src);
  }, []);

  const handleCall = useCallback((type: "audio" | "video") => {
    if (chatService.mode !== "backend") return;
    setCallType(type);
    setCallStatus("calling");
    setShowCallDialog(true);
    setCallDialogEverShown(true);
  }, []);

  const showChatMockBanner = isProductionBuild() && proxyMode === "mock";
  const callsEnabled = !showChatMockBanner && chatService.mode === "backend";

  const renderItem = useCallback(
    (_index: number, msg: Message) => (
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
    ),
    [currentUserId, playingVoiceId, isRTL, toggleVoicePlay, handleTextMsgClick, handleImageClick, retryFailedMessage],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full overflow-hidden">
      {viewingImage && (
        <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
      )}
      {callDialogEverShown && (
        <Suspense fallback={null}>
          <LazyCallDialog
            isOpen={showCallDialog}
            onClose={() => setShowCallDialog(false)}
            contactName={peerLabel}
            contactAvatar={peer.avatar}
            callType={callType}
            callStatus={callStatus}
          />
        </Suspense>
      )}

      {/* 与首页搜索条同节奏：emerald-600 + px-3 py-1.5 + h-10 内容行，无底部圆角 */}
      <div className="bg-emerald-600 px-3 py-1.5 flex-shrink-0 shadow-md safe-top">
        <div className="flex h-10 items-center gap-2">
          <ChatPeerAvatar avatar={peer.avatar} size="sm" className="ring-1 ring-white/40" />
          <div className="flex-1 min-w-0">
            <h2 className="text-white font-semibold text-sm leading-tight truncate">{peerLabel}</h2>
            <p className="text-white/85 text-[11px] leading-tight truncate">
              {peerBlocked ? t.community.contactBlockedLabel || "Blocked" : peer.subtitle || t.community.storeThreadSubtitle || "Chat"}
            </p>
          </div>
          <button
            type="button"
            className={`w-9 h-9 flex items-center justify-center active:scale-95 rounded-lg flex-shrink-0 ${ttsEnabled ? "active:bg-white/20" : "bg-white/15 active:bg-white/25"}`}
            onClick={toggleTts}
          >
            {ttsEnabled ? (
              <Volume2 className="w-[18px] h-[18px] text-white" strokeWidth={2.5} />
            ) : (
              <VolumeX className="w-[18px] h-[18px] text-white" strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 bg-white flex flex-col overflow-hidden min-h-0">
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
        {peerBlocked ? (
          <div className="flex-shrink-0 bg-amber-50 border-t border-amber-100 px-3 py-1.5 text-center text-xs text-amber-900">
            {t.community.threadInputBlockedHint}
          </div>
        ) : null}
        <ChatInputBar
          onSendText={sendTextMessage}
          onSendVoice={sendVoiceMessage}
          onSendImage={sendImageMessage}
          onCall={handleCall}
          isSending={isSending}
          callsEnabled={callsEnabled}
          adjoinDock
          readOnly={peerBlocked}
        />
      </div>
    </div>
  );
}

export function StoreCommunityShell({ storeUserId }: { storeUserId: string }) {
  const { t } = useLanguage();
  const { config } = useConfigContext();
  const scanAlbumInputRef = useRef<HTMLInputElement>(null);
  const farmerFallback = t.community.storeFarmerFallback || "Farmer";
  const labelPeer = useCallback(
    (peer: StorePeerRecord) => peerDisplayName(peer, farmerFallback),
    [farmerFallback],
  );

  const [shell, setShell] = useState<ShellMode>("recents");
  const [activePeer, setActivePeer] = useState<StorePeerRecord | null>(null);
  const [recentsRows, setRecentsRows] = useState<{ recent: StoreRecentRecord; peer?: StorePeerRecord }[]>([]);
  const [peers, setPeers] = useState<StorePeerRecord[]>([]);
  const [blockedPeerKeys, setBlockedPeerKeys] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<
    | { kind: "recent"; peerKey: string; channelId: string; x: number; y: number }
    | { kind: "contact"; peer: StorePeerRecord; x: number; y: number }
    | null
  >(null);
  const [showBindQR, setShowBindQR] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const refreshLists = useCallback(async () => {
    await removeLegacyDemoSupportContact(storeUserId);
    const [recents, plist, blockedList] = await Promise.all([
      listRecents(storeUserId),
      listPeersSorted(storeUserId),
      listBlockedPeerKeys(storeUserId),
    ]);
    setBlockedPeerKeys(new Set(blockedList));
    const rows = await Promise.all(
      recents.map(async (recent) => ({
        recent,
        peer: await getPeer(storeUserId, recent.peerKey),
      })),
    );
    setRecentsRows(rows);
    setPeers(plist);
  }, [storeUserId]);

  /** 恢复上次一对一线程完成后再持久化，避免首帧 recents 覆盖已保存的 thread */
  const [restoreReady, setRestoreReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRestoreReady(false);
    const saved = readStoreShellState(storeUserId);
    void (async () => {
      await refreshLists();
      if (cancelled) return;
      if (saved?.shell === "thread" && saved.peerKey) {
        const peer = await getPeer(storeUserId, saved.peerKey);
        if (!cancelled && peer) {
          await clearUnread(storeUserId, peer.peerKey);
          setActivePeer(peer);
          setShell("thread");
        }
      }
      if (!cancelled) setRestoreReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeUserId, refreshLists]);

  useEffect(() => {
    if (!storeUserId || !restoreReady) return;
    writeStoreShellState({
      storeUserId,
      shell,
      peerKey: shell === "thread" && activePeer ? activePeer.peerKey : null,
    });
  }, [storeUserId, shell, activePeer, restoreReady]);

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
  } = useMerchantBind({ onStorePeerAdded: refreshLists, isStoreShell: true });

  const [merchantBindEverShown, setMerchantBindEverShown] = useState(false);

  const hasVerifiedDomain = !!config?.chatContact?.verifiedDomains?.[0];

  // Cloud-sync farmers who have scanned this store's QR (cross-device peer list)
  // Deferred until after first paint so recents list can show from IndexedDB first.
  useEffect(() => {
    if (!storeUserId) return;
    let cancelled = false;
    const runSync = () => {
      void (async () => {
        await syncStorePeersFromCloud(storeUserId);
        if (!cancelled) {
          await refreshLists();
        }
      })();
    };
    let deferHandle: number | ReturnType<typeof setTimeout>;
    if (typeof requestIdleCallback !== "undefined") {
      deferHandle = requestIdleCallback(runSync, { timeout: 3000 });
    } else {
      deferHandle = setTimeout(runSync, 0);
    }
    const unsub = subscribeStorePeerInserts(storeUserId, async () => {
      await syncStorePeersFromCloud(storeUserId);
      await refreshLists();
    });
    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback !== "undefined" && typeof deferHandle === "number") {
        cancelIdleCallback(deferHandle);
      } else {
        clearTimeout(deferHandle as ReturnType<typeof setTimeout>);
      }
      unsub();
    };
  }, [storeUserId, refreshLists]);

  const totalUnread = useMemo(
    () =>
      recentsRows.reduce((s, r) => {
        if (blockedPeerKeys.has(r.recent.peerKey)) return s;
        return s + (r.recent.unread || 0);
      }, 0),
    [recentsRows, blockedPeerKeys],
  );
  useAppBadge(totalUnread);

  useEffect(() => {
    setStoreChatUnreadCount(totalUnread);
    return () => setStoreChatUnreadCount(0);
  }, [totalUnread]);

  const handleBackgroundIncoming = useCallback(
    (peer: StorePeerRecord, preview: string) => {
      const inActiveThread =
        shell === "thread" && activePeer?.peerKey === peer.peerKey;
      if (inActiveThread) return;
      const name = labelPeer(peer);
      const line = preview.trim() ? `${name}: ${preview}` : name;
      void toast.show({ text: line, duration: "short", position: "top" });
    },
    [shell, activePeer?.peerKey, labelPeer],
  );

  const grouped = useMemo(
    () => groupPeersByLetterForStore(peers, blockedPeerKeys),
    [peers, blockedPeerKeys],
  );

  /**
   * 后台 Realtime 订阅上限（仅影响「未打开对话时」能否推送到最近列表；通讯录/最近列表本身无此限制）。
   * 单 WS（getSupabaseBrowserClient）下 300 路 broadcast 订阅可接受；超出农户靠 Push 兜底。
   */
  const BACKGROUND_PEER_CAP = 300;

  /** 含尚无 recent 的新绑定农户，否则收不到后台 broadcast → 最近列表不更新 */
  const backgroundPeers = useMemo(() => {
    const byKey = new Map(peers.map((p) => [p.peerKey, p]));
    const ordered: StorePeerRecord[] = [];
    const seen = new Set<string>();
    for (const row of recentsRows) {
      const p = byKey.get(row.recent.peerKey);
      if (p && !seen.has(p.peerKey)) {
        ordered.push(p);
        seen.add(p.peerKey);
      }
    }
    for (const p of peers) {
      if (!seen.has(p.peerKey)) {
        ordered.push(p);
        seen.add(p.peerKey);
      }
    }
    return ordered.slice(0, BACKGROUND_PEER_CAP);
  }, [peers, recentsRows]);

  useStoreBackgroundMessages(
    storeUserId,
    backgroundPeers,
    shell === "thread" ? activePeer?.peerKey ?? null : null,
    refreshLists,
    handleBackgroundIncoming,
  );

  const openThread = useCallback(
    async (peer: StorePeerRecord) => {
      await clearUnread(storeUserId, peer.peerKey);
      setActivePeer(peer);
      setShell("thread");
      void refreshLists();
    },
    [storeUserId, refreshLists],
  );

  const handleQRScanResult = useCallback(
    (qrText: string) => {
      setShowScanner(false);
      processScanResult(qrText);
    },
    [setShowScanner, processScanResult],
  );

  const handleOpenScanSheet = useCallback(() => {
    setShowScanActionSheet(true);
    setMerchantBindEverShown(true);
  }, [setShowScanActionSheet]);

  const confirmDeleteRecent = useCallback(
    async (peerKey: string, channelId: string) => {
      const ok = window.confirm(t.community.confirmDeleteThread || "Delete this conversation?");
      if (!ok) return;
      await deleteRecentThread(storeUserId, peerKey);
      await chatService.deleteChannelMessages(channelId);
      setMenu(null);
      void refreshLists();
    },
    [storeUserId, t.community.confirmDeleteThread, refreshLists],
  );

  const confirmBlockContact = useCallback(
    async (peer: StorePeerRecord) => {
      const ok = window.confirm(t.community.confirmBlockContact || "Block messages from this contact?");
      if (!ok) return;
      await blockPeer(storeUserId, peer.peerKey);
      setMenu(null);
      void refreshLists();
    },
    [storeUserId, t.community.confirmBlockContact, refreshLists],
  );

  const confirmUnblockContact = useCallback(
    async (peer: StorePeerRecord) => {
      const ok = window.confirm(t.community.confirmUnblockContact || "Unblock?");
      if (!ok) return;
      await unblockPeer(storeUserId, peer.peerKey);
      setMenu(null);
      void refreshLists();
    },
    [storeUserId, t.community.confirmUnblockContact, refreshLists],
  );

  const confirmDeleteContact = useCallback(
    async (peer: StorePeerRecord) => {
      const ok = window.confirm(t.community.confirmDeleteContact || "Delete this contact?");
      if (!ok) return;
      await removePeerAndData(storeUserId, peer.peerKey);
      setMenu(null);
      if (activePeer?.peerKey === peer.peerKey) {
        setShell("recents");
        setActivePeer(null);
      }
      void refreshLists();
    },
    [storeUserId, t.community.confirmDeleteContact, refreshLists, activePeer?.peerKey],
  );

  const needsMerchantBind =
    merchantBindEverShown || showScanner || showScanActionSheet || scanResult !== null;

  const scrollToLetter = (letter: string) => {
    const el = sectionRefs.current[letter];
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-gradient-to-b from-emerald-50 to-white relative">
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

      {shell === "contacts" && <ContactsBackCapture onBack={() => setShell("recents")} />}

      {menu && (
        <button
          type="button"
          className="fixed inset-0 z-[60] bg-black/20"
          aria-label="Close menu"
          onClick={() => setMenu(null)}
        />
      )}
      {menu?.kind === "recent" && (
        <div
          className="fixed z-[61] bg-white rounded-xl shadow-xl border border-gray-200 py-1 min-w-[160px]"
          style={{ left: Math.min(menu.x, typeof window !== "undefined" ? window.innerWidth - 180 : 0), top: menu.y }}
        >
          <button
            type="button"
            className="w-full text-left px-4 py-2.5 text-sm text-red-600 active:bg-red-50"
            onClick={() => void confirmDeleteRecent(menu.peerKey, menu.channelId)}
          >
            {t.community.deleteThread || "Delete conversation"}
          </button>
        </div>
      )}
      {menu?.kind === "contact" && (
        <div
          className="fixed z-[61] bg-white rounded-xl shadow-xl border border-gray-200 py-1 min-w-[168px]"
          style={{ left: Math.min(menu.x, typeof window !== "undefined" ? window.innerWidth - 180 : 0), top: menu.y }}
        >
          {blockedPeerKeys.has(menu.peer.peerKey) ? (
            <>
              <button
                type="button"
                className="w-full text-left px-4 py-2.5 text-sm text-emerald-700 active:bg-emerald-50"
                onClick={() => void confirmUnblockContact(menu.peer)}
              >
                {t.community.restoreContact || t.community.unblockContact || "Restore"}
              </button>
              <div className="mx-3 h-px bg-gray-100" />
              <button
                type="button"
                className="w-full text-left px-4 py-2.5 text-sm text-red-600 active:bg-red-50"
                onClick={() => void confirmDeleteContact(menu.peer)}
              >
                {t.community.deleteContact || "Delete contact"}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="w-full text-left px-4 py-2.5 text-sm text-amber-700 active:bg-amber-50"
                onClick={() => void confirmBlockContact(menu.peer)}
              >
                {t.community.blockContact || "Block messages"}
              </button>
              <div className="mx-3 h-px bg-gray-100" />
              <button
                type="button"
                className="w-full text-left px-4 py-2.5 text-sm text-red-600 active:bg-red-50"
                onClick={() => void confirmDeleteContact(menu.peer)}
              >
                {t.community.deleteContact || "Delete contact"}
              </button>
            </>
          )}
        </div>
      )}

      {shell !== "thread" && (
        <div className="bg-emerald-600 px-3 py-1.5 flex-shrink-0 shadow-md safe-top">
          {shell === "contacts" ? (
            <div className="relative w-full h-10">
              <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center">
                <button
                  type="button"
                  className="flex items-center gap-0.5 text-white active:opacity-80 -ml-1 pl-1 pr-2 py-1 rounded-lg touch-manipulation"
                  onClick={() => setShell("recents")}
                >
                  <ChevronLeft className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm font-medium">{t.common.back}</span>
                </button>
              </div>
              <div className="flex h-10 items-center justify-center px-14 pointer-events-none">
                <h1 className="text-sm font-bold text-white truncate text-center">
                  {t.community.contacts || "Contacts"}
                </h1>
              </div>
            </div>
          ) : (
            <div className="flex h-10 items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-white min-w-0 flex-1">
                <MessageSquare className="w-5 h-5 flex-shrink-0" />
                <span className="font-bold text-sm truncate">{t.community.storeRecentsTitle || "Recent chats"}</span>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {hasVerifiedDomain ? (
                  <button
                    type="button"
                    className="w-9 h-9 flex items-center justify-center rounded-lg active:bg-white/20 text-white"
                    onClick={() => setShowBindQR(true)}
                    aria-label={t.profile.storeBindQrTitle ?? "Show QR"}
                  >
                    <QrCode className="w-5 h-5" strokeWidth={2.5} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="w-9 h-9 flex items-center justify-center rounded-lg active:bg-white/20 text-white flex-shrink-0"
                  onClick={handleOpenScanSheet}
                  aria-label="Scan"
                >
                  <ScanLine className="w-5 h-5" strokeWidth={2.5} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {shell === "recents" && (
        <div className="flex-1 overflow-y-auto bg-white min-h-0 flex flex-col pb-safe-nav">
          <button
            type="button"
            onClick={() => setShell("contacts")}
            className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 active:bg-gray-50 text-left touch-manipulation select-none flex-shrink-0"
            aria-label={t.community.contacts || "Contacts"}
          >
            <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0">
              <Users className="w-5 h-5 text-emerald-600" strokeWidth={2.25} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-gray-900">{t.community.contacts || "Contacts"}</span>
              {t.community.contactsEntrySubtitle ? (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{t.community.contactsEntrySubtitle}</p>
              ) : null}
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" aria-hidden />
          </button>
          {recentsRows.length === 0 ? (
            <div className="flex-1 px-4 py-10 text-center text-gray-500 text-sm leading-relaxed">
              {t.community.storeRecentsEmpty || "No conversations yet."}
            </div>
          ) : (
            recentsRows.map(({ recent, peer }) => {
              const title = peer ? labelPeer(peer) : farmerFallback;
              const blocked = blockedPeerKeys.has(recent.peerKey);
              const subtitle = recent.lastPreview || "";
              const avatar = peer?.avatar || "";
              return (
                <RecentRow
                  key={recent.id}
                  title={title}
                  subtitle={subtitle}
                  avatar={avatar}
                  unread={recent.unread}
                  lastMessageAt={recent.lastMessageAt}
                  blocked={blocked}
                  blockedLabel={t.community.contactBlockedLabel}
                  onPress={() => {
                    if (peer) void openThread(peer);
                  }}
                  onLongPress={() => {
                    const cx = typeof window !== "undefined" ? Math.max(16, window.innerWidth - 200) : 16;
                    const cy = 140;
                    setMenu({
                      kind: "recent",
                      peerKey: recent.peerKey,
                      channelId: peer?.channelId || "",
                      x: cx,
                      y: cy,
                    });
                  }}
                />
              );
            })
          )}
        </div>
      )}

      {shell === "contacts" && (
        <div className="flex-1 flex min-h-0 min-w-0 relative overflow-hidden">
          <div className="flex-1 overflow-y-auto overflow-x-hidden bg-white min-w-0 min-h-0 pb-safe">
            {grouped.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">
                {t.community.contactsEmpty || "No contacts. Tap + to add."}
              </div>
            ) : (
              grouped.map(({ letter, peers: sectionPeers }) => (
                <div
                  key={letter}
                  ref={(el) => {
                    sectionRefs.current[letter] = el;
                  }}
                >
                  <div className="sticky top-0 z-[1] bg-gray-100 px-4 py-1 text-xs font-semibold text-gray-600">
                    {letter}
                  </div>
                  {sectionPeers.map((p) => (
                    <ContactRow
                      key={p.id}
                      peer={p}
                      displayName={labelPeer(p)}
                      blocked={blockedPeerKeys.has(p.peerKey)}
                      blockedLabel={t.community.contactBlockedLabel}
                      onPress={() => void openThread(p)}
                      onLongPress={() => {
                        const cx = typeof window !== "undefined" ? window.innerWidth / 2 : 100;
                        const cy = 160;
                        setMenu({ kind: "contact", peer: p, x: cx, y: cy });
                      }}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
          <nav
            className="w-7 flex-shrink-0 min-h-0 min-w-[1.75rem] flex flex-col items-center justify-start gap-0.5 py-2 text-[10px] text-emerald-700 font-semibold bg-emerald-50/90 border-l border-emerald-100 overflow-y-auto overflow-x-hidden overscroll-y-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Alphabet index"
          >
            {ALPHABET_INDEX.map((L) => (
              <button
                key={L}
                type="button"
                className="leading-none py-0.5 px-1 rounded active:bg-emerald-200/60 touch-manipulation"
                onClick={() => scrollToLetter(L)}
              >
                {L}
              </button>
            ))}
          </nav>
        </div>
      )}

      {showBindQR && (
        <StoreBindQRCard
          onClose={() => setShowBindQR(false)}
          userId={storeUserId}
        />
      )}

      {shell === "thread" && activePeer && (
        <SecondaryView
          showTitle={false}
          fillContainer
          onClose={() => {
            setShell("recents");
            setActivePeer(null);
            void refreshLists();
          }}
        >
          <StoreThreadPanel
            peer={activePeer}
            storeUserId={storeUserId}
            onRefreshShell={refreshLists}
          />
        </SecondaryView>
      )}
    </div>
  );
}
