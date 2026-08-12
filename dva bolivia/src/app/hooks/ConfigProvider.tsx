import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { HomePageConfig } from './useHomeConfig';
import { deepMerge, MERGE_REPLACE } from '../utils';
import { storageGetJSON, storageSetJSON } from '../utils/safeStorage';
import { CONFIG_STORAGE_KEY, CONFIG_FOREGROUND_PULL_MIN_MS } from '../constants';
import {
  isSupabaseConfigured,
  fetchRemoteConfig,
  mergeRemoteAppConfigIntoLocal,
  applyResetConfigWithPreservedLocalSecrets,
  pushRemoteConfig,
  markConfigCmsDirty,
  clearConfigCmsDirty,
  type PushResult,
} from '../services/ConfigSyncService';
import { isConfigRemotePullPaused } from '../utils/configRemotePullPause';
import { syncCloudAIGuardFromRemoteConfig } from '../utils/cloudAIGuard';
import {
  getAccessToken,
  setAccessToken,
  clearAccessToken,
  ensureEdgeSessionReady,
  syncAccessTokenFromSupabaseSession,
  setServerUserId,
  setUserLoggedIn,
  isUserLoggedIn,
  SUPABASE_AUTH_STORAGE_KEY,
} from "../utils/auth";
import { mirrorSupabaseSessionToDexie } from '../utils/db';
import { getSupabaseBrowserClient } from '../utils/supabaseBrowser';
import { bridge } from '../utils/capacitor-bridge';

/**
 * ConfigProvider - 全局配置单例 Context
 * 
 * 解决 useHomeConfig 多实例问题：
 *   Keep-Alive 模式下 4 个 tab 页面各自调用 useHomeConfig()，
 *   每个实例独立 useState + JSON.parse + 事件监听 = 4 倍内存和事件开销。
 * 
 * 改为 Context Provider 在 Root 层提供单一数据源，
 * 所有子组件通过 useContext 共享同一份配置对象。
 * 
 * v2 更新：使用深度merge工具替代浅层合并，支持嵌套对象完整合并。
 * v3 更新：远程配置拉取（Step 2）+ 双写（Step 3）
 * v4 更新：远程写配置仅通过 Config Manager 的 pushRemoteWithAuth / forcePushConfig（用户 JWT 或写密钥）。
 * v5 更新：（已废弃）曾仅探测远程版本不合并。
 * v6 更新：每次启动/回到前台拉取 GET /config，将远程 app_config 合并进 localStorage；
 *   保留本机 userProfile、已绑定 chatContact、backendProxyConfig 中与远程合并后的密钥类字段。
 * v7 更新：Config Manager 本地保存（mirrorDevFiles）设置 CONFIG_CMS_DIRTY_KEY，合并时保留本地 CMS
 *   直至推送成功；内容管理器打开期间暂停前台自动拉取。
 * v8 更新：resetConfig 仅写入 defaultConfig 到 agri_home_config；合并保留本机 configWriteSecret（若已设）；不登出、不动 Supabase 会话。
 * v9 更新：回到前台时仅在超过 CONFIG_FOREGROUND_PULL_MIN_MS 后才自动 pull；开屏/图标等仍用本地 merged 配置，减少无意义 GET /config。
 */

// ---- Sync status type ----
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict';

/**
 * `mirrorDevFiles`: 仅应在 Config Manager 保存或导入全量配置时为 true。
 * 用户改头像/资料时若写 `taprootagrosetting/*.json`，Vite 会监听这些被 `defaultConfig` 引用的文件并整页重载，像「保存后应用重启」。
 */
export type SaveConfigOptions = { mirrorDevFiles?: boolean };

interface ConfigContextType {
  config: HomePageConfig;
  saveConfig: (newConfig: HomePageConfig, options?: SaveConfigOptions) => void;
  resetConfig: () => void;
  exportConfig: () => void;
  importConfig: (file: File) => Promise<void>;
  defaultConfig: HomePageConfig;
  /** Remote sync status */
  syncStatus: SyncStatus;
  /** Remote config version (from Supabase) */
  remoteVersion: number | null;
  /** Last successful sync timestamp (ms) */
  lastSyncTime: number | null;
  /** Last sync error message */
  lastSyncError: string | null;
  /** Whether Supabase credentials look valid */
  isRemoteConfigured: boolean;
  /** 拉取远程 app_config 并合并进本地（失败则仅更新状态） */
  pullRemoteConfig: () => Promise<void>;
  /** Force-push current config to remote (ignoring version) */
  forcePushConfig: () => Promise<void>;
  /** Push config to remote using user JWT (content super-admin) and optional write secret from config */
  pushRemoteWithAuth: (cfg: HomePageConfig, expectedVersion: number | null) => Promise<PushResult>;
}

const ConfigContext = createContext<ConfigContextType | null>(null);

// 默认配置从 useHomeConfig 导出（避免重复定义）
let _defaultConfig: HomePageConfig | null = null;

/**
 * Vite 开发：`/__taprootagro/config/save` 会把 config 写回 `taprootagrosetting/*.json`。
 * `userProfile.avatar` 的 data: 大图会让 JSON 极大，触发文件监听 → 整页 HMR/重载，体验像「保存编辑资料后 PWA 崩溃」。
 * 仅用于 dev 镜像请求；localStorage 仍写入完整 `newConfig`。
 */
function redactConfigForDevFileMirror(cfg: HomePageConfig): HomePageConfig {
  const av = cfg.userProfile?.avatar;
  if (typeof av === 'string' && av.startsWith('data:') && av.length > 256) {
    return {
      ...cfg,
      userProfile: {
        ...cfg.userProfile,
        avatar: '',
      },
    };
  }
  return cfg;
}

export function ConfigProvider({ children, defaultConfig }: { children: ReactNode; defaultConfig: HomePageConfig }) {
  _defaultConfig = defaultConfig;
  
  const [config, setConfig] = useState<HomePageConfig>(() => {
    const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
    if (parsed) {
      // 数组必须整段替换：MERGE_DEEP 的按索引合并会把默认模板里「未删除的尾项」与用户数据拼在一起，导致删不掉的幽灵项与跨区错乱。
      return deepMerge(defaultConfig as unknown as Record<string, unknown>, parsed as unknown as Record<string, unknown>, MERGE_REPLACE) as unknown as HomePageConfig;
    }
    return defaultConfig;
  });

  // ---- Remote sync state ----
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  // Track latest config in a ref so async callbacks always see current value
  const configRef = useRef(config);
  configRef.current = config;

  const lastForegroundPullAtRef = useRef(0);

  // ---- Helper: extract Supabase creds from config ----
  const getSupabaseCreds = useCallback((cfg: HomePageConfig) => {
    const bp = cfg.backendProxyConfig;
    return {
      url: bp?.supabaseUrl || '',
      key: bp?.supabaseAnonKey || '',
      edgeFunctionName: bp?.edgeFunctionName || 'server',
    };
  }, []);

  const isRemoteConfigured = isSupabaseConfigured(
    (config as any).backendProxyConfig?.supabaseUrl,
    (config as any).backendProxyConfig?.supabaseAnonKey,
  );

  // Key for storing the last-synced remote version in localStorage
  const REMOTE_VERSION_KEY = '__configRemoteVersion';

  // ---- 远程：拉取 app_config 并合并进本地（保留绑定与 userProfile 等）----
  const pullRemoteConfig = useCallback(async () => {
    const { url, key, edgeFunctionName } = getSupabaseCreds(configRef.current);
    if (!isSupabaseConfigured(url, key)) {
      setSyncStatus('idle');
      return;
    }

    setSyncStatus('syncing');
    try {
      const token = getAccessToken()?.trim() || null;
      const result = await fetchRemoteConfig(url, key, edgeFunctionName, {
        userAccessToken: token,
      });
      if (!result) {
        setSyncStatus('synced');
        setLastSyncTime(Date.now());
        setLastSyncError(null);
        return;
      }

      if (result.config && typeof result.config === 'object') {
        const local = configRef.current;
        const merged = mergeRemoteAppConfigIntoLocal(
          defaultConfig,
          local,
          result.config as unknown as Record<string, unknown>,
        );
        setConfig(merged);
        storageSetJSON(CONFIG_STORAGE_KEY, merged);
        window.dispatchEvent(new CustomEvent('configUpdate', { detail: merged }));
      }

      setRemoteVersion(result.version);
      try {
        localStorage.setItem(REMOTE_VERSION_KEY, String(result.version));
      } catch {
        /* ignore */
      }
      setSyncStatus('synced');
      setLastSyncTime(Date.now());
      setLastSyncError(null);
    } catch (err: any) {
      console.warn('[ConfigProvider] remote fetch failed:', err);
      setSyncStatus('error');
      setLastSyncError(err.message || String(err));
    }
  }, [defaultConfig, getSupabaseCreds]);

  // Run once on mount
  useEffect(() => {
    pullRemoteConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Supabase 的 session 与本地 agri_access_token 可能不同步（刷新/多标签）；供 AI、资料、IM 的 Edge 请求使用。 */
  useEffect(() => {
    if (!isRemoteConfigured) return;
    void ensureEdgeSessionReady();
  }, [isRemoteConfigured, config.backendProxyConfig?.supabaseUrl, config.backendProxyConfig?.supabaseAnonKey]);

  useEffect(() => {
    if (!isRemoteConfigured) return;
    const client = getSupabaseBrowserClient();
    if (!client) return;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (session?.access_token) {
        setAccessToken(session.access_token);
        if (session.user?.id) {
          setServerUserId(session.user.id);
          if (!isUserLoggedIn()) setUserLoggedIn(true);
        }
        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
          void mirrorSupabaseSessionToDexie();
        }
      } else if (event === 'SIGNED_OUT') {
        clearAccessToken();
        if (isUserLoggedIn()) setUserLoggedIn(false);
      }
    });
    return () => subscription.unsubscribe();
  }, [isRemoteConfigured, config.backendProxyConfig?.supabaseUrl, config.backendProxyConfig?.supabaseAnonKey]);

  // 5-minute heartbeat (< 1h JWT TTL) keeps long PWA/App sessions alive when JS timers are throttled.
  useEffect(() => {
    if (!isRemoteConfigured) return;
    const INTERVAL_MS = 5 * 60 * 1000;
    const id = setInterval(() => {
      void ensureEdgeSessionReady();
    }, INTERVAL_MS);
    return () => clearInterval(id);
  }, [isRemoteConfigured, config.backendProxyConfig?.supabaseUrl, config.backendProxyConfig?.supabaseAnonKey]);

  // PWA + Capacitor: resume from background → refresh JWT before AI / Edge calls.
  useEffect(() => {
    if (!isRemoteConfigured) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    void bridge.app.onStateChange(({ isActive }) => {
      if (isActive && !cancelled) void ensureEdgeSessionReady();
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      cleanup = fn;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [isRemoteConfigured, config.backendProxyConfig?.supabaseUrl, config.backendProxyConfig?.supabaseAnonKey]);

  // Multi-tab: another window refreshed taprootagro-auth → sync agri_access_token here.
  useEffect(() => {
    if (!isRemoteConfigured) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === SUPABASE_AUTH_STORAGE_KEY && e.newValue) {
        void syncAccessTokenFromSupabaseSession();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isRemoteConfigured, config.backendProxyConfig?.supabaseUrl, config.backendProxyConfig?.supabaseAnonKey]);

  // Sync client-side AI rate limits from cloudAIConfig (optional overrides)
  useEffect(() => {
    const c = config.cloudAIConfig;
    syncCloudAIGuardFromRemoteConfig(c);
  }, [
    config.cloudAIConfig?.clientDailyLimit,
    config.cloudAIConfig?.clientCooldownSeconds,
    config.cloudAIConfig?.clientWindowPerMin,
    config.cloudAIConfig?.clientChatMinIntervalSeconds,
    config.cloudAIConfig?.clientMaxImageSize,
    config.cloudAIConfig?.clientImageQuality,
  ]);

  // 回到前台 / iOS bfcache：静默续期 JWT；GET /config 仍按间隔触发
  useEffect(() => {
    const handleForeground = () => {
      void ensureEdgeSessionReady();
      if (!isRemoteConfigured || isConfigRemotePullPaused()) return;
      const now = Date.now();
      if (
        lastForegroundPullAtRef.current > 0 &&
        now - lastForegroundPullAtRef.current < CONFIG_FOREGROUND_PULL_MIN_MS
      ) {
        return;
      }
      lastForegroundPullAtRef.current = now;
      void pullRemoteConfig();
    };
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      handleForeground();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handleForeground);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handleForeground);
    };
  }, [pullRemoteConfig, isRemoteConfigured]);

  // 监听配置更新事件（来自其他 tab 或 ConfigManagerPage）
  useEffect(() => {
    const handleConfigUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<HomePageConfig>;
      if (customEvent.detail) {
        setConfig(customEvent.detail);
      }
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === CONFIG_STORAGE_KEY && e.newValue) {
        try {
          setConfig(JSON.parse(e.newValue));
        } catch { /* ignore */ }
      }
    };

    window.addEventListener('configUpdate', handleConfigUpdate);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('configUpdate', handleConfigUpdate);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // ---- Step 3: Dual-write saveConfig ----
  const saveConfig = useCallback((newConfig: HomePageConfig, options?: SaveConfigOptions) => {
    // 1. Immediate local save (always works, even offline)
    setConfig(newConfig);
    storageSetJSON(CONFIG_STORAGE_KEY, newConfig);
    window.dispatchEvent(new CustomEvent('configUpdate', { detail: newConfig }));

    // 2. Dev-only: 写回 taprootagrosetting/*.json 仅用于模板编辑（Config Manager / 导入）。
    //    运行时 save（头像、绑定商家等）切勿默认写盘，否则会触发 Vite 对 JSON 的 HMR → 整页刷新。
    if (import.meta.env.DEV && options?.mirrorDevFiles === true) {
      const mirror = redactConfigForDevFileMirror(newConfig);
      fetch('/__taprootagro/config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: mirror }),
      }).catch(() => { /* non-blocking, only available in Vite dev server */ });
    }

    if (options?.mirrorDevFiles === true) {
      markConfigCmsDirty();
    }

    // 3. Remote app_config push is only from Config Manager (pushRemoteWithAuth) or forcePushConfig.
  }, []);

  const pushRemoteWithAuth = useCallback(
    async (cfg: HomePageConfig, expectedVersion: number | null): Promise<PushResult> => {
      const { url, key, edgeFunctionName } = getSupabaseCreds(cfg);
      if (!isSupabaseConfigured(url, key)) {
        return { success: false, newVersion: 0, errorMessage: 'Remote not configured' };
      }
      const token = getAccessToken();
      const secret = cfg.backendProxyConfig?.configWriteSecret;
      setSyncStatus('syncing');
      try {
        const result = await pushRemoteConfig(url, key, cfg as any, expectedVersion, edgeFunctionName, {
          userAccessToken: token,
          configWriteSecret: secret,
        });
        if (result.success) {
          clearConfigCmsDirty();
          setRemoteVersion(result.newVersion);
          setSyncStatus('synced');
          setLastSyncTime(Date.now());
          setLastSyncError(null);
          try {
            localStorage.setItem(REMOTE_VERSION_KEY, String(result.newVersion));
          } catch {
            /* ignore */
          }
        } else if (result.conflict) {
          setSyncStatus('conflict');
          setLastSyncError(
            'Version conflict: remote config was modified by another device',
          );
        } else {
          setSyncStatus('error');
          setLastSyncError(result.errorMessage || 'Remote save failed');
        }
        return result;
      } catch (err: any) {
        setSyncStatus('error');
        setLastSyncError(err.message || String(err));
        return { success: false, newVersion: expectedVersion ?? 0, errorMessage: err.message };
      }
    },
    [getSupabaseCreds],
  );

  // ---- Force push (skip version check) ----
  const forcePushConfig = useCallback(async () => {
    const cfg = configRef.current;
    const { url, key } = getSupabaseCreds(cfg);
    if (!isSupabaseConfigured(url, key)) return;
    const hasToken = !!getAccessToken()?.trim();
    const hasSecret = !!cfg.backendProxyConfig?.configWriteSecret?.trim();
    if (import.meta.env.PROD && !hasToken && !hasSecret) return;
    await pushRemoteWithAuth(cfg, null);
  }, [getSupabaseCreds, pushRemoteWithAuth]);

  /**
   * 仅覆盖 localStorage `agri_home_config` 为出厂 defaultConfig（并保留本机 `configWriteSecret` 若已设置）。
   * 不修改登录态、不清 Supabase 会话、不删除 `agri_access_token`。
   */
  const resetConfig = useCallback(() => {
    clearConfigCmsDirty();
    const next = applyResetConfigWithPreservedLocalSecrets(defaultConfig, configRef.current);
    setConfig(next);
    storageSetJSON(CONFIG_STORAGE_KEY, next);
    window.dispatchEvent(new CustomEvent('configUpdate', { detail: next }));
  }, [defaultConfig]);

  const exportConfigFn = useCallback(() => {
    const dataStr = JSON.stringify(config, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `home-config-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [config]);

  const importConfigFn = useCallback((file: File) => {
    return new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const imported = JSON.parse(e.target?.result as string);
          saveConfig(imported, { mirrorDevFiles: true });
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }, [saveConfig]);

  return (
    <ConfigContext.Provider value={{
      config,
      saveConfig,
      resetConfig,
      exportConfig: exportConfigFn,
      importConfig: importConfigFn,
      defaultConfig,
      syncStatus,
      remoteVersion,
      lastSyncTime,
      lastSyncError,
      isRemoteConfigured,
      pullRemoteConfig,
      forcePushConfig,
      pushRemoteWithAuth,
    }}>
      {children}
    </ConfigContext.Provider>
  );
}

/** 从 Context 获取配置（推荐） */
export function useConfigContext(): ConfigContextType {
  const ctx = useContext(ConfigContext);
  if (!ctx) {
    throw new Error('useConfigContext must be used within ConfigProvider');
  }
  return ctx;
}