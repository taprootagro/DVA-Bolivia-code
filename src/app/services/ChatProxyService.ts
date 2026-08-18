// ============================================================================
// ChatProxyService — Chat Service (Supabase Realtime + Mock fallback)
// ============================================================================
// Main chat abstraction used by CommunityPage / useChatMessages.
//
// Two modes:
//   - "backend": delegates to SupabaseChatAdapter (Realtime + chat-supabase Edge)
//   - "mock":    simulates chat locally when Supabase URL/Anon Key are absent
// ============================================================================

import { storageGet } from '../utils/safeStorage';
import { CONFIG_STORAGE_KEY } from '../constants';
import { getUserId } from '../utils/auth';
import { getIMAdapter, resetIMAdapter } from './IMAdapter';
import type { ChatProvider } from '../hooks/useHomeConfig';

export interface ChatMessage {
  id: string;
  channelName: string;
  senderId: string;
  content: string;
  type: "text" | "image" | "voice" | "video";
  timestamp: number;
  status: "sending" | "sent" | "failed";
  read: boolean;
  duration?: number;
  /** For voice messages: playable audio URL (objectURL in mock, remote URL in backend) */
  audioUrl?: string;
}

// ---- Configuration ----
interface ProxyCfg {
  supabaseUrl: string;
  supabaseAnonKey: string;
  enabled: boolean;
  chatProvider: ChatProvider;
}

function getProxyConfig(): ProxyCfg {
  const defaults: ProxyCfg = {
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL || "",
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
    enabled: false,
    chatProvider: 'supabase',
  };

  try {
    const saved = storageGet(CONFIG_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const bpc = parsed.backendProxyConfig;
      if (bpc) {
        return {
          supabaseUrl: bpc.supabaseUrl || defaults.supabaseUrl,
          supabaseAnonKey: bpc.supabaseAnonKey || defaults.supabaseAnonKey,
          enabled: bpc.enabled ?? defaults.enabled,
          chatProvider: 'supabase',
        };
      }
    }
  } catch {
    // ignore parse errors
  }
  return defaults;
}

function isBackendAvailable(): boolean {
  const cfg = getProxyConfig();
  return cfg.enabled && !!cfg.supabaseUrl && !cfg.supabaseUrl.includes("your-");
}

// ---- Provider display names ----
export const CHAT_PROVIDER_INFO: Record<ChatProvider, { name: string; nameZh: string; features: string[] }> = {
  supabase: {
    name: 'Supabase Realtime',
    nameZh: 'Supabase 实时库',
    features: ['Text', 'Image', 'Voice', 'Recorded video', 'Realtime', 'Storage'],
  },
};

// ---- Mock data store ----
const mockMessageStore: ChatMessage[] = [];

export class ChatProxyService {
  private currentUserId: string = "me";
  private currentChannel: string = "default-channel";
  private _listeners = new Set<(msg: ChatMessage) => void>();
  private _targetUserId: string | null = null;
  private _mode: "backend" | "mock" = "mock";
  private _mockWarningShown = false;
  private _seenMessageIds: Set<string> = new Set();
  private _adapterUnsubscribe: (() => void) | null = null;
  /** Serializes leave/join to avoid Realtime races during role shell swap */
  private _channelOpChain: Promise<void> = Promise.resolve();

  private enqueueChannelOp<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this._channelOpChain.then(() => fn());
    this._channelOpChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Await in-flight leave/join before starting a new channel session */
  waitForChannelSwitch(): Promise<void> {
    return this._channelOpChain;
  }

  constructor() {
    this.currentUserId = getUserId() || "";
    this.refreshMode();
    window.addEventListener("configUpdate", () => this.refreshMode());
  }

  refreshMode() {
    const newMode = isBackendAvailable() ? "backend" : "mock";
    if (newMode !== this._mode) {
      console.log(`[ChatProxy] Mode changed: ${this._mode} → ${newMode}`);
      this._mockWarningShown = false;
      // Reset IM adapter when config changes
      if (newMode === "backend") {
        resetIMAdapter();
      }
    }
    this._mode = newMode;
    const cfg = getProxyConfig();
    console.log(`[ChatProxy] Running in ${this._mode.toUpperCase()} mode | Provider: ${cfg.chatProvider} | Direct SDK`);
  }

  get mode() {
    this._mode = isBackendAvailable() ? "backend" : "mock";
    return this._mode;
  }

  /** Get current configured chat provider */
  get provider(): ChatProvider {
    return getProxyConfig().chatProvider;
  }

  /** Get provider display info */
  get providerInfo() {
    return CHAT_PROVIDER_INFO[this.provider] ?? CHAT_PROVIDER_INFO.supabase;
  }

  onMessage(listener: (msg: ChatMessage) => void) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notifyListeners(msg: ChatMessage) {
    this._listeners.forEach((fn) => fn(msg));
  }

  setUserId(userId: string) {
    this.currentUserId = userId;
  }

  /** Set the target user ID for the current chat session */
  setTargetUserId(targetUserId: string) {
    this._targetUserId = targetUserId;
  }

  /** Get the current target user ID */
  get targetUserId(): string | null {
    return this._targetUserId;
  }

  /**
   * Generate a deterministic 1-to-1 channel name from two user IDs.
   * Sorts alphabetically so both sides get the same channel name.
   */
  static generateChannelName(userId1: string, userId2: string): string {
    const sorted = [userId1, userId2].sort();
    return `dm_${sorted[0]}_${sorted[1]}`;
  }

  // ========================================================================
  // MESSAGE RECEIVING — via IM SDK WebSocket (no polling needed)
  // ========================================================================

  /**
   * Start listening for messages. In direct SDK mode, messages arrive via
   * WebSocket push — no polling needed. This method subscribes to the
   * IMAdapter's onMessage callback.
   */
  startPolling(_intervalMs?: number): void {
    this.stopPolling(); // Clear any existing subscription

    if (this._mode === "backend") {
      const adapter = getIMAdapter();
      // Subscribe to incoming messages from SDK
      this._adapterUnsubscribe = adapter.onMessage((incomingMsg) => {
        if (this._seenMessageIds.has(incomingMsg.id)) return;
        this._seenMessageIds.add(incomingMsg.id);
        if (incomingMsg.senderId === this.currentUserId) return;
        this.notifyListeners(incomingMsg);
      });
      console.log('[ChatProxy] Subscribed to IM SDK messages (WebSocket push, no polling)');
    } else {
      console.log("[ChatProxy][MOCK] Mock mode active — no auto-reply simulation. Static display only.");
    }
  }

  /** Stop listening for messages (solo unsubscribe, keeps WebSocket alive) */
  stopPolling(): void {
    if (this._adapterUnsubscribe) {
      this._adapterUnsubscribe();
      this._adapterUnsubscribe = null;
      console.log("[ChatProxy] Unsubscribed from IM SDK messages");
    }
  }

  /**
   * Fully leave the current channel: unsubscribe listeners AND tear down the
   * underlying WebSocket connection. Use this on thread close / page hide /
   * component unmount to release Realtime resources.
   *
   * Also clears seen-message dedup set so a future join starts fresh; history
   * load will re-seed it via markSeen().
   */
  leaveChannel(): void {
    void this.enqueueChannelOp(async () => {
      this.stopPolling();
      if (this._mode === "backend") {
        try {
          const adapter = getIMAdapter();
          adapter.disconnect();
        } catch (e) {
          console.warn("[ChatProxy] leaveChannel disconnect failed", e);
        }
      }
      this._seenMessageIds.clear();
      console.log("[ChatProxy] Left channel (WebSocket released)");
    });
  }

  /** Whether listening is currently active */
  get isPollingActive(): boolean {
    return this._adapterUnsubscribe !== null;
  }

  /** Mark existing message IDs as seen (to prevent duplicates on initial load) */
  markSeen(messageIds: string[]): void {
    for (const id of messageIds) {
      this._seenMessageIds.add(id);
    }
  }

  // ========================================================================
  // JOIN CHANNEL — Connect IM SDK to channel
  // ========================================================================
  async joinChannel(
    channelName: string,
    /** 单聊对方 IM 用户 id（与通讯录 imUserId 一致）；与 channelName 相同时表示 C2C，否则一般为群 id */
    peerUserId?: string,
  ): Promise<{ token: string; appId: string; uid: string | number }> {
    return this.enqueueChannelOp(async () => {
      this.currentChannel = channelName;
      const cfg = getProxyConfig();

      if (this._mode === "backend") {
        console.log(`[ChatProxy] Connecting IM SDK to channel: ${channelName} (provider: ${cfg.chatProvider})`);
        const adapter = getIMAdapter();
        await adapter.connect(this.currentUserId, channelName, peerUserId);
        console.log(`[ChatProxy] IM SDK connected to channel: ${channelName}`);
        return { token: 'sdk-direct', appId: cfg.chatProvider, uid: this.currentUserId };
      }

      // Mock mode
      console.log(`[ChatProxy][MOCK] Generating mock token for channel: ${channelName}`);
      await this.simulateLatency(300);
      return {
        token: `mock-token-${Date.now()}`,
        appId: `MOCK_${cfg.chatProvider.toUpperCase()}`,
        uid: this.currentUserId,
      };
    });
  }

  // ========================================================================
  // SEND MESSAGE — via IM SDK direct
  // ========================================================================
  async sendMessage(
    content: string,
    type: "text" | "image" | "voice" | "video" = "text",
    duration?: number,
    targetUserId?: string,
    audioBlob?: Blob,
    videoBlob?: Blob
  ): Promise<ChatMessage> {
    if (this._mode === "mock" && !this._mockWarningShown) {
      console.warn(
        "[ChatProxy] Backend proxy not enabled. Running in MOCK mode.\n" +
        "Go to ConfigManager → Backend Proxy tab to configure IM provider and enable backend proxy."
      );
      this._mockWarningShown = true;
    }

    const newMessage: ChatMessage = {
      id: `m${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      channelName: this.currentChannel,
      senderId: this.currentUserId,
      content,
      type,
      timestamp: Date.now(),
      status: "sending",
      read: false,
      duration,
    };

    if (this._mode === "backend") {
      try {
        const adapter = getIMAdapter();
        const result = await adapter.sendMessage({
          id: newMessage.id,
          content: newMessage.content,
          type: newMessage.type,
          senderId: newMessage.senderId,
          targetUserId: targetUserId || this._targetUserId || "",
          channelName: this.currentChannel,
          duration: newMessage.duration,
          audioBlob,
          videoBlob,
        });

        if (result.success) {
          if (result.id) {
            newMessage.id = result.id;
          }
          newMessage.status = "sent";
          newMessage.timestamp = result.serverTimestamp || newMessage.timestamp;
          if (result.mediaUrl) {
            newMessage.content = result.mediaUrl;
          }
          if (result.audioUrl) {
            newMessage.audioUrl = result.audioUrl;
            newMessage.content = result.audioUrl;
          }
        } else {
          newMessage.status = "failed";
          console.error("[ChatProxy] Send failed:", result.error);
        }
        return newMessage;
      } catch (error) {
        console.error("[ChatProxy] Send failed:", error);
        newMessage.status = "failed";
        return newMessage;
      }
    }

    // Mock mode
    await this.simulateLatency(200);
    newMessage.status = "sent";

    // For voice messages in mock mode: create a playable objectURL from the blob
    if (type === "voice" && audioBlob) {
      const objectUrl = URL.createObjectURL(audioBlob);
      newMessage.audioUrl = objectUrl;
      newMessage.content = objectUrl;
    }

    if (type === "video" && videoBlob) {
      newMessage.content = URL.createObjectURL(videoBlob);
    }

    mockMessageStore.push(newMessage);

    // Mock auto-reply
    if (this._targetUserId) {
      this._scheduleMockReply(newMessage);
    }

    return newMessage;
  }

  /**
   * Schedule a mock auto-reply in mock mode.
   */
  private _scheduleMockReply(userMsg: ChatMessage): void {
    const delay = 1000 + Math.random() * 2000;
    const mockReplies: Record<string, string[]> = {
      text: [
        "好的，收到了！",
        "没问题，我马上处理",
        "这个产品目前有货，需要我帮你预留吗？",
        "价格方面可以再商量",
        "OK, received!",
        "I'll check and get back to you",
        "Yes, this product is available",
      ],
      image: [
        "图片收到了，我看看",
        "Product photo received, let me check",
      ],
      voice: [
        "语音已收听",
        "Voice message received",
      ],
      video: [
        "视频已收到",
        "Video received",
      ],
    };

    const replies = mockReplies[userMsg.type] || mockReplies.text;
    const replyContent = replies[Math.floor(Math.random() * replies.length)];

    setTimeout(() => {
      const replyMsg: ChatMessage = {
        id: `mock_reply_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        channelName: userMsg.channelName,
        senderId: this._targetUserId || "",
        content: replyContent,
        type: "text",
        timestamp: Date.now(),
        status: "sent",
        read: false,
      };
      mockMessageStore.push(replyMsg);
      this.notifyListeners(replyMsg);
      console.log(`[ChatProxy][MOCK] Auto-reply from ${this._targetUserId}: "${replyContent}"`);
    }, delay);
  }

  // ========================================================================
  // GET HISTORY — via IM SDK
  // ========================================================================
  async getHistory(
    channelName: string,
    peerUserId?: string,
    limit = 50,
  ): Promise<ChatMessage[]> {
    if (this._mode === "backend") {
      const adapter = getIMAdapter();
      return adapter.getHistory(channelName, limit, peerUserId);
    }

    // Mock mode
    await this.simulateLatency(500);
    return mockMessageStore.filter((m) => m.channelName === channelName);
  }

  /**
   * D8: Pagination — fetch messages strictly older than `beforeIso`.
   * Returns ascending order; empty array means we've reached the start of history.
   */
  async getMessagesBefore(
    channelName: string,
    beforeIso: string,
    limit = 30,
  ): Promise<ChatMessage[]> {
    if (!channelName || !beforeIso) return [];
    if (this._mode === "backend") {
      const adapter = getIMAdapter();
      if (typeof adapter.getBefore === "function") {
        return adapter.getBefore(channelName, beforeIso, limit);
      }
      return [];
    }
    const cutoff = new Date(beforeIso).getTime();
    if (!Number.isFinite(cutoff)) return [];
    return mockMessageStore
      .filter((m) => m.channelName === channelName && m.timestamp < cutoff)
      .slice(-limit);
  }

  /**
   * Incremental fetch since a given server timestamp (ms).
   * Used by useChatMessages when the page returns from `hidden` to `visible`,
   * to merge messages that may have arrived while the WebSocket was released.
   */
  async getMessagesSince(
    channelName: string,
    sinceMs: number,
  ): Promise<ChatMessage[]> {
    if (!channelName || !Number.isFinite(sinceMs) || sinceMs <= 0) return [];
    if (this._mode === "backend") {
      const adapter = getIMAdapter();
      if (typeof adapter.getSince === "function") {
        return adapter.getSince(channelName, sinceMs);
      }
      return [];
    }
    return mockMessageStore.filter(
      (m) => m.channelName === channelName && m.timestamp > sinceMs,
    );
  }

  /**
   * Best-effort: delete server-side messages for a channel (Supabase) or IM SDK if implemented.
   */
  async deleteChannelMessages(channelName: string): Promise<boolean> {
    if (!channelName?.trim()) return false;
    const purgeLocal = async () => {
      try {
        const { purgeChannel } = await import("./chatLocalStore");
        await purgeChannel(channelName);
      } catch (e) {
        console.warn("[ChatProxy] local purgeChannel failed:", e);
      }
    };

    if (this._mode !== "backend") {
      mockMessageStore.splice(
        0,
        mockMessageStore.length,
        ...mockMessageStore.filter((m) => m.channelName !== channelName),
      );
      await purgeLocal();
      return true;
    }
    const adapter = getIMAdapter();
    if (typeof adapter.deleteChannel === "function") {
      try {
        const ok = await adapter.deleteChannel(channelName);
        if (ok) await purgeLocal();
        return ok;
      } catch (e) {
        console.warn("[ChatProxy] deleteChannelMessages failed:", e);
        return false;
      }
    }
    return false;
  }

  // ---- Helpers ----
  private simulateLatency(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton export
export const chatService = new ChatProxyService();