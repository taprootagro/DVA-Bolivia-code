// ============================================================================
// IMAdapter — Supabase Realtime only
// ============================================================================
// Single provider: 'supabase' (chat_messages + Realtime + Storage).
// Legacy tencent-im / cometchat code paths were removed in the account-based QR
// migration — see farmer-developer/SUPABASE_CN.md.
// ============================================================================

import type { ChatMessage } from './ChatProxyService';
import type { IMMode, ChatProvider } from '../hooks/useHomeConfig';
import { storageGet } from '../utils/safeStorage';
import { SupabaseChatAdapter } from './SupabaseChatAdapter';
import { CONFIG_STORAGE_KEY } from '../constants';

// ---- Adapter Interface ----

export interface IMAdapterConfig {
  imMode: IMMode;
  chatProvider: ChatProvider;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface IIMAdapter {
  /** Adapter mode name */
  readonly mode: IMMode;

  /** Human-readable description of the current mode */
  readonly modeLabel: string;

  /** Initialize the adapter (connect SDK, subscribe, etc.) */
  connect(userId: string, channelName: string, peerUserId?: string): Promise<void>;

  /** Disconnect and clean up */
  disconnect(): void;

  /** Send a message through this adapter */
  sendMessage(msg: {
    id: string;
    content: string;
    type: 'text' | 'image' | 'voice' | 'video';
    senderId: string;
    targetUserId: string;
    channelName: string;
    duration?: number;
    audioBlob?: Blob;
    videoBlob?: Blob;
  }): Promise<{
    success: boolean;
    /** Server-assigned message id (UUID from chat_messages) */
    id?: string;
    serverTimestamp?: number;
    audioUrl?: string;
    mediaUrl?: string;
    error?: string;
  }>;

  /** Fetch message history (peerUserId kept for backward signature compat; unused in Supabase adapter) */
  getHistory(channelName: string, limit?: number, peerUserId?: string): Promise<ChatMessage[]>;

  /** Incremental fetch: messages created after sinceMs (ascending). Used for reconnect / resume catch-up. */
  getSince?(channelName: string, sinceMs: number): Promise<ChatMessage[]>;

  /** Pagination: messages strictly older than beforeIso (ascending). Used for "scroll up to load older". */
  getBefore?(channelName: string, beforeIso: string, limit?: number): Promise<ChatMessage[]>;

  /** Register a listener for incoming messages */
  onMessage(listener: (msg: ChatMessage) => void): () => void;

  /** Whether the adapter is currently connected */
  readonly isConnected: boolean;

  /** Best-effort delete remote/history for a channel (chat_messages rows + storage via Edge). */
  deleteChannel?(channelName: string): Promise<boolean>;
}

// ---- Config Reader ----

export function getIMAdapterConfig(): IMAdapterConfig {
  const defaults: IMAdapterConfig = {
    imMode: 'im-provider-direct',
    chatProvider: 'supabase',
    supabaseUrl: '',
    supabaseAnonKey: '',
  };

  try {
    const saved = storageGet(CONFIG_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const bpc = parsed.backendProxyConfig;
      if (bpc) {
        return {
          imMode: 'im-provider-direct',
          chatProvider: 'supabase',
          supabaseUrl: bpc.supabaseUrl || defaults.supabaseUrl,
          supabaseAnonKey: bpc.supabaseAnonKey || defaults.supabaseAnonKey,
        };
      }
    }
  } catch { /* ignore */ }
  return defaults;
}

// ---- Mode Label ----
export const IM_MODE_LABELS: Record<IMMode, { zh: string; en: string; desc_zh: string; desc_en: string; icon: string; color: string; activeColor: string }> = {
  'im-provider-direct': {
    zh: 'Supabase Realtime',
    en: 'Supabase Realtime',
    desc_zh: 'Postgres + Realtime + Storage：账号级绑定，消息走 WebSocket 订阅 chat_messages，媒体存 chat-media 桶',
    desc_en: 'Postgres + Realtime + Storage: account-based binding; messages via WebSocket over chat_messages, media in chat-media bucket',
    icon: 'S',
    color: 'border-emerald-400 bg-emerald-50',
    activeColor: 'ring-emerald-400',
  },
};

// ---- Factory ----

/**
 * Create the IM adapter (always Supabase Realtime).
 */
export function createIMAdapter(config?: IMAdapterConfig): IIMAdapter {
  const cfg = config || getIMAdapterConfig();
  return new SupabaseChatAdapter(cfg);
}

/** Singleton adapter instance — recreated when config changes */
let _currentAdapter: IIMAdapter | null = null;

/**
 * Get or create the singleton adapter.
 */
export function getIMAdapter(): IIMAdapter {
  if (_currentAdapter) {
    return _currentAdapter;
  }
  _currentAdapter = createIMAdapter();
  return _currentAdapter;
}

/**
 * Force recreate the adapter (e.g. after config save in ConfigManager).
 */
export function resetIMAdapter(): IIMAdapter {
  if (_currentAdapter) {
    _currentAdapter.disconnect();
    _currentAdapter = null;
  }
  return getIMAdapter();
}
