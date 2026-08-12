// ============================================================================
// WebSocket Version Negotiation - WebSocket版本协商系统
// ============================================================================
// 为实时通信添加版本支持，确保客户端和服务端兼容性
//
// 核心功能：
//   1. 连接时版本协商
//   2. 自动降级重连
//   3. 心跳保活（支持慢速网络）
//   4. 断线重连（指数退避）
//   5. 消息队列（离线缓存）
//   6. 性能监控集成
//
// 使用场景：
//   - Supabase Realtime 连接
//   - ChatProxy WebSocket
//   - 农业物联网设备实时数据
// ============================================================================

import type { ApiVersion } from './apiVersion';
import { getVersionFallbackChain } from './apiVersion';
import { errorMonitor } from './errorMonitor';

// ============================================================================
// 类型定义
// ============================================================================

export interface WSVersionInfo {
  /** WebSocket协议版本 */
  version: ApiVersion;
  
  /** 支持的子协议 */
  subprotocol?: string;
  
  /** 心跳间隔（ms）*/
  heartbeatInterval?: number;
  
  /** 消息格式 */
  messageFormat?: 'json' | 'binary' | 'msgpack';
}

export interface WSConnectionOptions {
  /** WebSocket URL */
  url: string;
  
  /** 首选版本 */
  preferredVersion?: ApiVersion;
  
  /** 是否启用自动降级 */
  enableFallback?: boolean;
  
  /** 自定义协议 */
  protocols?: string[];
  
  /** 心跳间隔（ms，默认30s）*/
  heartbeatInterval?: number;
  
  /** 重连配置 */
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
  };
  
  /** 消息队列大小 */
  queueSize?: number;
  
  /** 事件回调 */
  onOpen?: (version: ApiVersion) => void;
  onMessage?: (data: unknown, version: ApiVersion) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  onVersionNegotiated?: (version: ApiVersion, fallback: boolean) => void;
}

export interface WSMessage {
  type: 'ping' | 'pong' | 'data' | 'version-negotiation';
  version?: ApiVersion;
  payload?: unknown;
  timestamp: number;
}

// ============================================================================
// WebSocket连接管理器
// ============================================================================

const DEFAULT_RECONNECT_CONFIG = {
  enabled: true,
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
};

export class VersionedWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private options: WSConnectionOptions;
  private currentVersion: ApiVersion = 'v3';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: WSMessage[] = [];
  private isConnecting = false;
  private isIntentionallyClosed = false;
  private lastPongTime = 0;
  private connectionStartTime = 0;

  constructor(options: WSConnectionOptions) {
    this.url = options.url;
    this.options = {
      ...options,
      reconnect: { ...DEFAULT_RECONNECT_CONFIG, ...options.reconnect },
      heartbeatInterval: options.heartbeatInterval || 30000,
      queueSize: options.queueSize || 100,
    };
    this.currentVersion = options.preferredVersion || 'v3';
  }

  /**
   * 连接WebSocket（带版本协商）
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      console.log('[WSVersion] Already connected or connecting');
      return;
    }

    this.isConnecting = true;
    this.isIntentionallyClosed = false;
    this.connectionStartTime = Date.now();

    const fallbackChain = this.options.enableFallback
      ? getVersionFallbackChain(this.currentVersion)
      : [this.currentVersion];

    for (const version of fallbackChain) {
      try {
        await this.attemptConnection(version);
        
        // 成功连接
        this.currentVersion = version;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        
        const isFallback = version !== (this.options.preferredVersion || 'v3');
        
        // 跟踪连接成功
        const connectionTime = Date.now() - this.connectionStartTime;
        errorMonitor.trackWebSocketConnection(version, true);
        errorMonitor.trackVersionUsage(version, connectionTime);
        
        if (isFallback) {
          errorMonitor.trackFallback(this.options.preferredVersion || 'v3', version);
        }
        
        this.options.onVersionNegotiated?.(version, isFallback);
        
        console.log(`[WSVersion] Connected successfully with ${version}${isFallback ? ' (fallback)' : ''}`);
        return;
      } catch (error) {
        console.warn(`[WSVersion] Failed to connect with ${version}:`, error);
        
        // 跟踪连接失败
        errorMonitor.trackWebSocketConnection(version, false);
        
        if (error instanceof Error) {
          errorMonitor.trackWebSocketError(version, error);
        }
        
        // 继续尝试下一个版本
        continue;
      }
    }

    // 所有版本都失败
    this.isConnecting = false;
    const error = new Error(`WebSocket connection failed for all versions (${fallbackChain.join(', ')})`);
    this.options.onError?.(error);
    errorMonitor.trackWebSocketError(this.currentVersion, error);
    
    // 尝试重连
    this.scheduleReconnect();
  }

  /**
   * 尝试使用指定版本连接
   */
  private attemptConnection(version: ApiVersion): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 构建协议列表（包含版本信息）
        const protocols = [
          `taproot-${version}`,
          ...(this.options.protocols || []),
        ];

        // 创建WebSocket连接
        this.ws = new WebSocket(this.url, protocols);

        const openHandler = () => {
          this.ws?.removeEventListener('open', openHandler);
          this.ws?.removeEventListener('error', errorHandler);
          
          // 发送版本协商消息
          this.sendVersionNegotiation(version);
          
          // 启动心跳
          this.startHeartbeat();
          
          // 发送队列中的消息
          this.flushQueue();
          
          this.options.onOpen?.(version);
          resolve();
        };

        const errorHandler = (event: Event) => {
          this.ws?.removeEventListener('open', openHandler);
          this.ws?.removeEventListener('error', errorHandler);
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.addEventListener('open', openHandler);
        this.ws.addEventListener('error', errorHandler);

        // 消息处理
        this.ws.addEventListener('message', (event) => {
          this.handleMessage(event, version);
        });

        // 关闭处理
        this.ws.addEventListener('close', (event) => {
          this.handleClose(event);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 发送版本协商消息
   */
  private sendVersionNegotiation(version: ApiVersion) {
    const message: WSMessage = {
      type: 'version-negotiation',
      version,
      timestamp: Date.now(),
      payload: {
        clientVersion: version,
        supportedVersions: this.options.enableFallback
          ? getVersionFallbackChain(version)
          : [version],
      },
    };
    
    this.sendRaw(message);
  }

  /**
   * 发送消息
   */
  send(data: unknown): boolean {
    const message: WSMessage = {
      type: 'data',
      version: this.currentVersion,
      payload: data,
      timestamp: Date.now(),
    };

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(message);
      return true;
    } else {
      // 连接未就绪，加入队列
      this.queueMessage(message);
      return false;
    }
  }

  /**
   * 发送原始消息
   */
  private sendRaw(message: WSMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('[WSVersion] Send failed:', error);
        if (error instanceof Error) {
          errorMonitor.trackWebSocketError(this.currentVersion, error);
        }
      }
    }
  }

  /**
   * 消息入队
   */
  private queueMessage(message: WSMessage) {
    this.messageQueue.push(message);
    
    // 限制队列大小
    while (this.messageQueue.length > (this.options.queueSize || 100)) {
      this.messageQueue.shift();
    }
  }

  /**
   * 刷新队列
   */
  private flushQueue() {
    if (this.messageQueue.length === 0) return;
    
    console.log(`[WSVersion] Flushing ${this.messageQueue.length} queued messages`);
    
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.sendRaw(message);
      }
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(event: MessageEvent, version: ApiVersion) {
    try {
      const message = JSON.parse(event.data) as WSMessage;
      
      switch (message.type) {
        case 'pong':
          this.lastPongTime = Date.now();
          break;
          
        case 'version-negotiation':
          // 服务端可能要求降级
          if (message.version && message.version !== version) {
            console.log(`[WSVersion] Server requested version ${message.version}`);
            this.currentVersion = message.version;
          }
          break;
          
        case 'data':
          this.options.onMessage?.(message.payload, version);
          break;
          
        default:
          // 未知消息类型
          break;
      }
    } catch (error) {
      console.error('[WSVersion] Message parsing failed:', error);
    }
  }

  /**
   * 处理连接关闭
   */
  private handleClose(event: CloseEvent) {
    console.log(`[WSVersion] Connection closed: ${event.code} ${event.reason}`);
    
    this.stopHeartbeat();
    this.options.onClose?.(event.code, event.reason);
    
    // 如果不是主动关闭，尝试重连
    if (!this.isIntentionallyClosed && this.options.reconnect?.enabled) {
      this.scheduleReconnect();
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    
    const interval = this.options.heartbeatInterval || 30000;
    
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // 发送ping
        const ping: WSMessage = {
          type: 'ping',
          version: this.currentVersion,
          timestamp: Date.now(),
        };
        this.sendRaw(ping);
        
        // 检查上次pong时间
        if (this.lastPongTime > 0 && Date.now() - this.lastPongTime > interval * 2) {
          console.warn('[WSVersion] Heartbeat timeout, reconnecting...');
          this.reconnect();
        }
      }
    }, interval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect() {
    const config = this.options.reconnect || DEFAULT_RECONNECT_CONFIG;
    
    if (!config.enabled || this.reconnectAttempts >= (config.maxAttempts || 5)) {
      console.error('[WSVersion] Max reconnect attempts reached');
      return;
    }
    
    const delay = Math.min(
      config.initialDelay! * Math.pow(config.backoffMultiplier!, this.reconnectAttempts),
      config.maxDelay!
    );
    
    console.log(`[WSVersion] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${config.maxAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * 重连
   */
  reconnect() {
    this.close();
    this.connect();
  }

  /**
   * 关闭连接
   */
  close(code = 1000, reason = 'Client closed') {
    this.isIntentionallyClosed = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(code, reason);
      this.ws = null;
    }
  }

  /**
   * 获取当前状态
   */
  getState(): {
    readyState: number;
    version: ApiVersion;
    queueSize: number;
    reconnectAttempts: number;
  } {
    return {
      readyState: this.ws?.readyState || WebSocket.CLOSED,
      version: this.currentVersion,
      queueSize: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * 获取当前版本
   */
  getVersion(): ApiVersion {
    return this.currentVersion;
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ============================================================================
// 便捷工厂函数
// ============================================================================

/**
 * 创建版本化WebSocket连接
 */
export function createVersionedWebSocket(
  url: string,
  options: Omit<WSConnectionOptions, 'url'> = {}
): VersionedWebSocket {
  return new VersionedWebSocket({ url, ...options });
}
