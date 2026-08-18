// ============================================================================
// ChatUserService - User ID Generation & Local Profile
// ============================================================================
// 聊天链路唯一 provider = 'supabase'，用户无需在第三方 IM 平台预注册。
// 保留的职责：
//   1. 生成/同步持久化 user ID（优先使用服务端分配的 auth ID，否则本地 UUID v4）。
//   2. 在本地存储中维护昵称、头像等 profile。
//   3. 对外暴露 isRegistered()/registerOnProvider() 的"默认 ok"签名，供
//      useChatMessages 等调用方保持旧接口形态（不再发起网络请求）。
//
// 历史版本曾把该服务对接 Tencent IM / CometChat 的用户注册接口
// （走 chat-token Edge function）。自 2026 年起全面改为 Supabase 单后端，
// chat-token 及其相关流程已下线；此处只保留极小的 API surface 以免引起
// 大面积调用方改动。
// ============================================================================

import { getUserId, isServerAssignedId } from '../utils/auth';
import { storageGet, storageSet, storageRemove } from '../utils/safeStorage';
import type { ChatProvider } from '../hooks/useHomeConfig';

const USER_STORAGE_KEY = 'agri_chat_user';
const PROVIDER: ChatProvider = 'supabase';

export interface ChatUser {
  userId: string;
  nickname: string;
  avatarUrl: string;
  createdAt: number;
  registrations: Partial<Record<ChatProvider, { registered: boolean; registeredAt?: number }>>;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').substring(0, 8).toUpperCase();
}

function loadUser(): ChatUser | null {
  try {
    const raw = storageGet(USER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function saveUser(user: ChatUser): void {
  storageSet(USER_STORAGE_KEY, JSON.stringify(user));
}

class ChatUserService {
  private _user: ChatUser | null = null;

  constructor() {
    this._user = loadUser();
  }

  getUser(): ChatUser {
    if (!this._user) {
      this._user = this.createNewUser();
      saveUser(this._user);
      console.log(`[ChatUser] New user created: ${this._user.userId} (${this.getShortId()}) [${isServerAssignedId() ? 'server' : 'local'}]`);
    }

    const authId = getUserId();
    if (authId && this._user.userId !== authId) {
      console.log(`[ChatUser] Syncing to auth ID: ${authId} (was: ${this._user.userId}) [${isServerAssignedId() ? 'server' : 'local'}]`);
      this._user.userId = authId;
      if (isServerAssignedId()) {
        this._user.registrations = {};
      }
      saveUser(this._user);
    }

    return this._user;
  }

  getUserId(): string {
    return this.getUser().userId;
  }

  getShortId(): string {
    return shortId(this.getUserId());
  }

  hasUser(): boolean {
    return this._user !== null;
  }

  updateProfile(nickname?: string, avatarUrl?: string): void {
    const user = this.getUser();
    if (nickname !== undefined) user.nickname = nickname;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
    saveUser(user);
    this._user = user;
  }

  resetUser(): ChatUser {
    this._user = this.createNewUser();
    saveUser(this._user);
    console.log(`[ChatUser] User reset. New ID: ${this._user.userId}`);
    return this._user;
  }

  // ---------- Provider Registration (supabase-only, no-op shim) ----------

  isRegistered(): boolean {
    return this.getUser().registrations[PROVIDER]?.registered === true;
  }

  isRegisteredOn(provider: ChatProvider): boolean {
    return this.getUser().registrations[provider]?.registered === true;
  }

  /**
   * 兼容旧接口：Supabase 模式下用户无需在外部 IM 平台预注册，
   * 这里只做本地标记并直接返回成功。
   */
  async registerOnProvider(): Promise<{ success: boolean; error?: string }> {
    this.markRegistered(PROVIDER);
    return { success: true };
  }

  // ---------- Helpers ----------

  private createNewUser(): ChatUser {
    const authId = getUserId();
    const userId = authId || generateUUID();
    return {
      userId,
      nickname: `User_${authId ? authId.slice(-6) : shortId(generateUUID())}`,
      avatarUrl: '',
      createdAt: Date.now(),
      registrations: {},
    };
  }

  private markRegistered(provider: ChatProvider): void {
    const user = this.getUser();
    user.registrations[provider] = { registered: true, registeredAt: Date.now() };
    saveUser(user);
    this._user = user;
  }

  getRegistrationSummary(): { provider: ChatProvider; registered: boolean; registeredAt?: number }[] {
    const user = this.getUser();
    return [{
      provider: PROVIDER,
      registered: user.registrations[PROVIDER]?.registered === true,
      registeredAt: user.registrations[PROVIDER]?.registeredAt,
    }];
  }

  clearAll(): void {
    try {
      storageRemove(USER_STORAGE_KEY);
    } catch { /* ignore */ }
    this._user = null;
  }
}

export const chatUserService = new ChatUserService();
