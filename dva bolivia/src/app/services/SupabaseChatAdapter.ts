// ============================================================================
// SupabaseChatAdapter — Postgres + Storage + Realtime（无腾讯/CometChat SDK）
// ============================================================================

import { type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage } from "./ChatProxyService";
import type { IIMAdapter, IMAdapterConfig } from "./IMAdapter";
import type { IMMode } from "../hooks/useHomeConfig";
import { getAccessToken, syncAccessTokenFromSupabaseSession } from "../utils/auth";
import { getSupabaseBrowserClient } from "../utils/supabaseBrowser";

function inferImageExt(blob: Blob, content: string): string {
  const t = (blob.type || "").toLowerCase();
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  if (content.startsWith("data:")) {
    const m = /^data:image\/([a-z0-9]+)/i.exec(content);
    if (m?.[1]) return m[1].toLowerCase().replace("jpeg", "jpg");
  }
  return "webp";
}

function inferAudioExt(blob: Blob): string {
  const t = (blob.type || "").toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  return "webm";
}

function inferVideoExt(blob: Blob): string {
  const t = (blob.type || "").toLowerCase();
  if (t.includes("mp4")) return "mp4";
  if (t.includes("webm")) return "webm";
  if (t.includes("quicktime")) return "mov";
  return "mp4";
}

function rowToMessage(row: {
  id: string;
  channel_id: string;
  sender_id: string;
  msg_type: string;
  body: string | null;
  media_url: string | null;
  duration_ms: number | null;
  created_at: string;
}): ChatMessage {
  const t = row.msg_type as ChatMessage["type"];
  const ts = new Date(row.created_at).getTime();
  const base: ChatMessage = {
    id: row.id,
    channelName: row.channel_id,
    senderId: row.sender_id,
    type: t,
    content: t === "text" ? (row.body || "") : (row.media_url || ""),
    timestamp: ts,
    status: "sent",
    read: false,
  };
  if (t === "voice") {
    const sec = row.duration_ms != null ? row.duration_ms / 1000 : 0;
    base.duration = sec > 0 ? Math.max(1, Math.round(sec)) : 5;
    base.audioUrl = row.media_url || undefined;
  }
  return base;
}

/** Attach login JWT to Realtime so chat:{channel} broadcast RLS passes. */
async function ensureSharedRealtimeAuth(client: SupabaseClient): Promise<void> {
  await syncAccessTokenFromSupabaseSession();
  const { data: { session } } = await client.auth.getSession();
  if (session?.access_token) {
    client.realtime.setAuth(session.access_token);
  }
}

export class SupabaseChatAdapter implements IIMAdapter {
  readonly mode: IMMode = "im-provider-direct";
  readonly modeLabel = "Supabase (Realtime + Storage)";

  private _config: IMAdapterConfig;
  private _userId = "";
  private _channelName = "";
  private _connected = false;
  private _listeners = new Set<(msg: ChatMessage) => void>();
  private _client: SupabaseClient | null = null;
  private _realtime: RealtimeChannel | null = null;

  /** 最近一条已知服务端消息时间戳（ms），用于断线重连后 since 增量补拉 */
  private _lastServerTs = 0;
  /** 是否曾经成功订阅过（区分首次订阅与重连） */
  private _wasSubscribedOnce = false;
  /** 重连退避定时器 */
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续重连尝试次数（用于指数退避） */
  private _retryAttempts = 0;

  constructor(config: IMAdapterConfig) {
    this._config = config;
  }

  get isConnected() {
    return this._connected;
  }

  /** 累进式更新 _lastServerTs，仅在更新的前提下修改 */
  private updateLastServerTs(ms: number): void {
    if (Number.isFinite(ms) && ms > this._lastServerTs) {
      this._lastServerTs = ms;
    }
  }

  /** Edge chat-supabase 要求用户 JWT；无 token 时退回 anon（仅健康检查等会成功，消息接口会 401） */
  private headers(): HeadersInit {
    const k = this._config.supabaseAnonKey;
    const sessionJwt = getAccessToken();
    const bearer = sessionJwt?.trim() || "";
    const authHeader = bearer
      ? `Bearer ${bearer}`
      : k
        ? `Bearer ${k}`
        : "";
    return {
      "Content-Type": "application/json",
      ...(k ? { Authorization: authHeader, apikey: k } : {}),
    };
  }

  private baseUrl(): string {
    return `${this._config.supabaseUrl.replace(/\/$/, "")}/functions/v1/chat-supabase`;
  }

  /** multipart /upload 用，勿带 Content-Type */
  private formUploadHeaders(): HeadersInit {
    const k = this._config.supabaseAnonKey;
    const sessionJwt = getAccessToken()?.trim();
    const authHeader = sessionJwt
      ? `Bearer ${sessionJwt}`
      : k
        ? `Bearer ${k}`
        : "";
    return k ? { Authorization: authHeader, apikey: k } : {};
  }

  private async apiJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429) {
        try {
          const j = JSON.parse(text) as {
            error?: string;
            retry_after_seconds?: number;
          };
          if (j?.error === "CHAT_RATE_LIMIT") {
            const ra = Number(j.retry_after_seconds);
            throw new Error(
              Number.isFinite(ra) && ra > 0
                ? `CHAT_RATE_LIMIT:${Math.ceil(ra)}`
                : "CHAT_RATE_LIMIT",
            );
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("CHAT_RATE_LIMIT")) throw e;
        }
      }
      throw new Error(text || `HTTP ${res.status}`);
    }
    return JSON.parse(text) as T;
  }

  async connect(userId: string, channelName: string, _peerUserId?: string): Promise<void> {
    // 清理上一会话的 channel，但保留共享 client（C5）
    this.releaseChannel();
    this._userId = userId;
    this._channelName = channelName;

    const { supabaseUrl, supabaseAnonKey } = this._config;
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("CHAT_REALTIME_CONFIG_MISSING");
    }

    const client = getSupabaseBrowserClient();
    if (!client) {
      throw new Error("CHAT_REALTIME_CLIENT_UNAVAILABLE");
    }

    this._client = client;
    await ensureSharedRealtimeAuth(this._client);
    this._connected = true;

    this.setupChannel();
  }

  /**
   * 仅释放当前 channel + 重置会话级状态；共享 client 不动。
   * 切换会话或可见性变化时调用都很轻量。
   */
  private releaseChannel(): void {
    if (this._retryTimer != null) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryAttempts = 0;
    this._lastServerTs = 0;
    this._wasSubscribedOnce = false;
    if (this._realtime && this._client) {
      void this._client.removeChannel(this._realtime);
    }
    this._realtime = null;
  }

  disconnect(): void {
    this._connected = false;
    this.releaseChannel();
    // C5: 复用 getSupabaseBrowserClient 单例；disconnect 只释放 channel
    this._client = null;
    console.log("[SupabaseChat] Disconnected (channel released, shared client kept)");
  }

  /**
   * 创建并订阅 chat:{channelName} 的 broadcast 频道。
   * 可被 scheduleRetry 反复调用，每次会先释放旧 channel 再重建。
   */
  private setupChannel(): void {
    if (!this._connected || !this._client || !this._channelName) return;

    void ensureSharedRealtimeAuth(this._client).then(() => {
      if (!this._connected || !this._client || !this._channelName) return;
      this.setupChannelInner();
    });
  }

  private setupChannelInner(): void {
    if (!this._connected || !this._client || !this._channelName) return;

    if (this._realtime) {
      void this._client.removeChannel(this._realtime);
      this._realtime = null;
    }

    const channelName = this._channelName;
    const ch = this._client.channel(`chat:${channelName}`);

    ch.on(
      "broadcast",
      { event: "message" },
      (evt: { payload?: unknown }) => {
        const payload = evt?.payload as Parameters<typeof rowToMessage>[0] | undefined;
        if (!payload?.id) return;
        const msg = rowToMessage(payload);
        this.updateLastServerTs(msg.timestamp);
        this._listeners.forEach((fn) => fn(msg));
      },
    );

    ch.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        console.log("[SupabaseChat] Realtime subscribed:", channelName);
        this._retryAttempts = 0;
        if (this._retryTimer != null) {
          clearTimeout(this._retryTimer);
          this._retryTimer = null;
        }
        // 重连成功且已有基线时间戳 → 启动增量补拉对齐缺失消息
        if (this._wasSubscribedOnce && this._lastServerTs > 0) {
          void this.catchUpSince(this._lastServerTs);
        }
        this._wasSubscribedOnce = true;
        return;
      }
      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        console.warn(`[SupabaseChat] channel status: ${status}`, err);
        this.scheduleRetry();
      }
    });

    this._realtime = ch;
  }

  /** 指数退避重连（0.5s 起，倍增至 30s 封顶；disconnect 后自动失效） */
  private scheduleRetry(): void {
    if (!this._connected) return;
    if (this._retryTimer != null) return;

    const attempt = this._retryAttempts;
    const delay = Math.min(30000, 500 * Math.pow(2, attempt));
    this._retryAttempts = attempt + 1;
    console.warn(
      `[SupabaseChat] scheduling resubscribe in ${delay}ms (attempt ${this._retryAttempts})`,
    );
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this._connected) return;
      this.setupChannel();
    }, delay);
  }

  /**
   * 断线重连成功后的增量补拉：通过 HTTP 拉取 created_at > sinceMs 的消息，
   * 逐条走与 broadcast 相同的 listener 路径，由上层 ChatProxyService 依 id 去重。
   */
  private async catchUpSince(sinceMs: number): Promise<void> {
    const channelName = this._channelName;
    if (!channelName) return;
    try {
      const iso = new Date(sinceMs).toISOString();
      const data = await this.apiJson<{
        messages: Parameters<typeof rowToMessage>[0][];
      }>(
        `/messages?channel_id=${encodeURIComponent(channelName)}&since=${encodeURIComponent(iso)}`,
        { method: "GET" },
      );
      for (const row of data.messages || []) {
        const msg = rowToMessage(row);
        this.updateLastServerTs(msg.timestamp);
        this._listeners.forEach((fn) => fn(msg));
      }
      if ((data.messages || []).length > 0) {
        console.log(
          `[SupabaseChat] catch-up since=${iso} applied ${data.messages.length} message(s)`,
        );
      }
    } catch (e) {
      console.warn("[SupabaseChat] catch-up since failed", e);
    }
  }

  /**
   * 外部可调用的增量拉取（供 hook / visibilitychange 等显式使用）。
   * 返回升序 ChatMessage 列表；副作用：同步更新 _lastServerTs。
   */
  async getSince(channelName: string, sinceMs: number): Promise<ChatMessage[]> {
    try {
      const iso = new Date(sinceMs).toISOString();
      const data = await this.apiJson<{
        messages: Parameters<typeof rowToMessage>[0][];
      }>(
        `/messages?channel_id=${encodeURIComponent(channelName)}&since=${encodeURIComponent(iso)}`,
        { method: "GET" },
      );
      const msgs = (data.messages || []).map(rowToMessage);
      for (const m of msgs) this.updateLastServerTs(m.timestamp);
      return msgs;
    } catch (e) {
      console.warn("[SupabaseChat] getSince failed", e);
      return [];
    }
  }

  /**
   * B3: 媒体直传 Storage —— 客户端先 POST /upload/sign 拿签名，再 PUT 直传。
   * 失败时（签名 4xx/5xx 或 PUT 失败）自动回退老 multipart /upload，保持双轨过渡。
   */
  private async uploadMedia(
    blob: Blob,
    kind: "image" | "voice" | "video",
    ext: string,
    channelId: string,
    senderId: string,
  ): Promise<string> {
    try {
      const sign = await this.apiJson<{
        uploadUrl: string;
        token: string;
        objectPath: string;
        publicUrl: string;
      }>("/upload/sign", {
        method: "POST",
        body: JSON.stringify({ channel_id: channelId, kind, ext }),
      });

      const putRes = await fetch(sign.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          "x-upsert": "false",
        },
        body: blob,
      });
      if (!putRes.ok) {
        const t = await putRes.text().catch(() => "");
        throw new Error(`storage PUT ${putRes.status} ${t}`);
      }
      return sign.publicUrl;
    } catch (e) {
      console.warn(`[SupabaseChat] direct upload failed, fallback to /upload`, e);
      return this.uploadMediaLegacy(blob, kind, channelId, senderId, ext);
    }
  }

  /** Legacy multipart 上传（保留 30 天后再删除）—— B3 直传失败时自动回退。 */
  private async uploadMediaLegacy(
    blob: Blob,
    kind: "image" | "voice" | "video",
    channelId: string,
    senderId: string,
    ext: string,
  ): Promise<string> {
    const filename =
      kind === "image" ? `image.${ext || "jpg"}` :
      kind === "voice" ? `voice.${ext || "webm"}` :
      `video.${ext || "mp4"}`;
    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("channel_id", channelId);
    fd.append("sender_id", senderId);
    fd.append("kind", kind);
    const up = await fetch(`${this.baseUrl()}/upload`, {
      method: "POST",
      headers: this.formUploadHeaders(),
      body: fd,
    });
    if (!up.ok) {
      const t = await up.text().catch(() => "");
      throw new Error(t || `legacy upload HTTP ${up.status}`);
    }
    const { url } = (await up.json()) as { url: string };
    if (!url) throw new Error("legacy upload returned empty url");
    return url;
  }

  async sendMessage(msg: {
    id: string;
    content: string;
    type: "text" | "image" | "voice" | "video";
    senderId: string;
    targetUserId: string;
    channelName: string;
    duration?: number;
    audioBlob?: Blob;
    videoBlob?: Blob;
  }): Promise<{
    success: boolean;
    id?: string;
    serverTimestamp?: number;
    audioUrl?: string;
    mediaUrl?: string;
    error?: string;
  }> {
    const channelId = msg.channelName;
    const senderId = msg.senderId;

    const serverIdFrom = (row: Record<string, unknown> | undefined): string | undefined => {
      const raw = row?.id;
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    };

    try {
      if (msg.type === "text") {
        const data = await this.apiJson<{ message: Record<string, unknown> }>("/messages", {
          method: "POST",
          body: JSON.stringify({
            channel_id: channelId,
            sender_id: senderId,
            msg_type: "text",
            body: msg.content,
          }),
        });
        const created = data.message?.created_at as string | undefined;
        const ts = created ? new Date(created).getTime() : Date.now();
        this.updateLastServerTs(ts);
        return {
          success: true,
          id: serverIdFrom(data.message),
          serverTimestamp: ts,
        };
      }

      if (msg.type === "image") {
        let blob: Blob;
        if (msg.content.startsWith("data:") || msg.content.startsWith("http")) {
          const res = await fetch(msg.content);
          blob = await res.blob();
        } else {
          return { success: false, error: "Invalid image" };
        }
        const ext = inferImageExt(blob, msg.content);
        const url = await this.uploadMedia(blob, "image", ext, channelId, senderId);
        const data = await this.apiJson<{ message: Record<string, unknown> }>("/messages", {
          method: "POST",
          body: JSON.stringify({
            channel_id: channelId,
            sender_id: senderId,
            msg_type: "image",
            media_url: url,
          }),
        });
        const created = data.message?.created_at as string | undefined;
        const ts = created ? new Date(created).getTime() : Date.now();
        this.updateLastServerTs(ts);
        return {
          success: true,
          id: serverIdFrom(data.message),
          serverTimestamp: ts,
          mediaUrl: url,
        };
      }

      if (msg.type === "voice" && msg.audioBlob) {
        const ext = inferAudioExt(msg.audioBlob);
        const url = await this.uploadMedia(msg.audioBlob, "voice", ext, channelId, senderId);
        const durationMs = msg.duration != null ? Math.round(msg.duration * 1000) : null;
        const data = await this.apiJson<{ message: Record<string, unknown> }>("/messages", {
          method: "POST",
          body: JSON.stringify({
            channel_id: channelId,
            sender_id: senderId,
            msg_type: "voice",
            media_url: url,
            duration_ms: durationMs,
          }),
        });
        const created = data.message?.created_at as string | undefined;
        const ts = created ? new Date(created).getTime() : Date.now();
        this.updateLastServerTs(ts);
        return {
          success: true,
          id: serverIdFrom(data.message),
          serverTimestamp: ts,
          audioUrl: url,
          mediaUrl: url,
        };
      }

      if (msg.type === "video" && msg.videoBlob) {
        const ext = inferVideoExt(msg.videoBlob);
        const url = await this.uploadMedia(msg.videoBlob, "video", ext, channelId, senderId);
        const data = await this.apiJson<{ message: Record<string, unknown> }>("/messages", {
          method: "POST",
          body: JSON.stringify({
            channel_id: channelId,
            sender_id: senderId,
            msg_type: "video",
            media_url: url,
          }),
        });
        const created = data.message?.created_at as string | undefined;
        const ts = created ? new Date(created).getTime() : Date.now();
        this.updateLastServerTs(ts);
        return {
          success: true,
          id: serverIdFrom(data.message),
          serverTimestamp: ts,
          mediaUrl: url,
        };
      }

      return { success: false, error: "Unsupported or missing media" };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      console.error("[SupabaseChat] send failed", e);
      return { success: false, error: m };
    }
  }

  /**
   * D8: 历史分页 —— 取 created_at < beforeIso 的最近 limit 条；升序返回。
   * 不更新 _lastServerTs（已是当前最新基线，不应被旧消息覆盖回退）。
   */
  async getBefore(
    channelName: string,
    beforeIso: string,
    limit = 30,
  ): Promise<ChatMessage[]> {
    try {
      const data = await this.apiJson<{
        messages: Parameters<typeof rowToMessage>[0][];
      }>(
        `/messages?channel_id=${encodeURIComponent(channelName)}` +
          `&before=${encodeURIComponent(beforeIso)}&limit=${Math.max(1, Math.min(100, limit))}`,
        { method: "GET" },
      );
      return (data.messages || []).map(rowToMessage);
    } catch (e) {
      console.warn("[SupabaseChat] getBefore failed", e);
      return [];
    }
  }

  async getHistory(channelName: string, limit = 50, _peerUserId?: string): Promise<ChatMessage[]> {
    try {
      const data = await this.apiJson<{ messages: Parameters<typeof rowToMessage>[0][] }>(
        `/messages?channel_id=${encodeURIComponent(channelName)}&limit=${limit}`,
        { method: "GET" },
      );
      const msgs = (data.messages || []).map(rowToMessage);
      // 基线时间戳：为避免断线重连后拉回全量历史，history 加载后立刻把最新消息 ts 记下来
      for (const m of msgs) this.updateLastServerTs(m.timestamp);
      return msgs;
    } catch (e) {
      console.warn("[SupabaseChat] getHistory failed", e);
      return [];
    }
  }

  onMessage(listener: (msg: ChatMessage) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  async deleteChannel(channelName: string): Promise<boolean> {
    try {
      await this.apiJson<{ ok?: boolean; deleted?: number }>("/messages/delete", {
        method: "POST",
        body: JSON.stringify({ channel_id: channelName }),
      });
      return true;
    } catch (e) {
      console.warn("[SupabaseChat] deleteChannel failed", e);
      return false;
    }
  }
}
