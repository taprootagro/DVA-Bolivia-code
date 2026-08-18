/**
 * ============================================================================
 * Capacitor Bridge — 原生能力统一封装层
 * ============================================================================
 *
 * 设计目标：
 *   一份源码 → 两种运行环境（PWA 浏览器 / Capacitor App）
 *
 * 核心机制：
 *   1. 运行时检测 Capacitor 环境（不依赖任何 Capacitor 包）
 *   2. App 构建时 workflow 自动生成 capacitor-loader.ts，将插件注册到 window.__CAP_PLUGINS__
 *   3. Bridge 从全局注册表读取插件；PWA 模式下注册表不存在 → 自动走 Web 降级
 *
 * 使用方式：
 *   import { bridge } from './utils/capacitor-bridge';
 *
 *   // 自动选择原生相机或 Web 文件选择器
 *   const photo = await bridge.camera.takePhoto();
 *
 *   // 自动选择原生 GPS 或 navigator.geolocation
 *   const pos = await bridge.geo.getCurrentPosition();
 *
 * 体积影响：
 *   PWA 模式：0 KB（无 capacitor-loader.ts，无插件代码）
 *   App 模式：所有插件被 Vite 打包进 bundle，通过注册表按需使用
 *
 * ============================================================================
 */

import {
  loadVoicesWeb,
  preloadVoicesWeb,
  resolveVoiceForLang,
  type ResolvedVoice,
  type VoiceLike,
} from './ttsVoice';

// ============================================================================
// 平台检测（零依赖，不 import @capacitor/core）
// ============================================================================

/**
 * 检测当前是否运行在 Capacitor 原生环境中
 * 利用 Capacitor 注入到 window 上的全局对象判断
 */
export function isNative(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof (window as any).Capacitor?.isNativePlatform === 'function' &&
      (window as any).Capacitor.isNativePlatform()
    );
  } catch {
    return false;
  }
}

/**
 * 获取当前平台
 */
export function getPlatform(): 'android' | 'ios' | 'web' {
  try {
    if (typeof window !== 'undefined' && (window as any).Capacitor?.getPlatform) {
      return (window as any).Capacitor.getPlatform();
    }
  } catch { /* ignore */ }
  return 'web';
}


// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 安全加载 Capacitor 插件
 *
 * 加载顺序：
 *   1. 先查 window.__CAP_PLUGINS__ 全局注册表
 *      （App 构建时由 workflow 自动生成的 capacitor-loader.ts 填充）
 *   2. 注册表不存在（PWA 模式） → 返回 null → 调用方走 Web 降级
 *
 * 为什么不用 dynamic import：
 *   - PWA 构建时 Capacitor 包未安装，Vite dev server 解析 import() 会报错
 *   - App 构建时 workflow 已通过 capacitor-loader.ts 用 static import 预加载
 *     所有插件到全局对象，bridge 直接读取即可，不需要运行时 import()
 */
function loadPlugin(moduleName: string): any {
  try {
    const registry = (window as any).__CAP_PLUGINS__;
    return registry?.[moduleName] ?? null;
  } catch {
    return null;
  }
}

/** Web 端文件选择器（相机/相册降级方案） */
function webFilePicker(accept: string, capture?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // 用户取消时不会触发 onchange，用 focus 检测
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!input.files?.length) resolve(null);
      }, 500);
    }, { once: true });
    input.click();
  });
}

/** File 转 base64 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 去掉 data:image/xxx;base64, 前缀
      resolve(result.split(',')[1] || result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function mimeFromPhotoPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export type NativePhotoInput = {
  base64?: string;
  webPath?: string;
  dataUrl?: string;
};

/**
 * 将原生相机/相册结果统一转为 data URL（供 chatImagePrepare 压缩）。
 * pickImages 常只返回 webPath（capacitor:// / file://），不能直接 fetch 裸路径。
 */
export async function readNativePhotoToDataUrl(
  photo: NativePhotoInput,
): Promise<string | null> {
  if (photo.dataUrl?.trim()) return photo.dataUrl.trim();
  if (photo.base64?.trim()) {
    return `data:image/jpeg;base64,${photo.base64.trim()}`;
  }

  const webPath = photo.webPath?.trim();
  if (!webPath) return null;
  if (webPath.startsWith('data:')) return webPath;

  if (webPath.startsWith('http://') || webPath.startsWith('https://')) {
    try {
      const res = await fetch(webPath);
      if (!res.ok) return null;
      return await blobToDataUrl(await res.blob());
    } catch {
      return null;
    }
  }

  const convertFn = (window as any).Capacitor?.convertFileSrc;
  if (typeof convertFn === 'function') {
    try {
      const url = convertFn(webPath);
      const res = await fetch(url);
      if (res.ok) return await blobToDataUrl(await res.blob());
    } catch {
      /* fall through */
    }
  }

  if (isNative()) {
    const mod = loadPlugin('@capacitor/filesystem');
    if (mod?.Filesystem?.readFile) {
      const { Filesystem } = mod;
      const pathAttempts = [webPath];
      if (webPath.startsWith('file://')) {
        pathAttempts.push(webPath.replace(/^file:\/\//, ''));
      }
      for (const path of pathAttempts) {
        try {
          const result = await Filesystem.readFile({ path });
          const data = result.data as string;
          if (data) {
            return `data:${mimeFromPhotoPath(webPath)};base64,${data}`;
          }
        } catch {
          /* try next */
        }
      }
    }
  }

  return null;
}


// ============================================================================
// 第一档：核心功能（8 个插件）
// ============================================================================

// ── 相机 ─────────────────────────────────────────────────────────────────
export const camera = {
  /**
   * 拍照
   * App: 调用系统相机 → 返回 base64 / dataUrl
   * Web: 调用 <input type="file" capture="environment"> → 返回 base64
   */
  async takePhoto(options?: {
    quality?: number;       // 0-100, 默认 80
    width?: number;         // 最大宽度
    height?: number;        // 最大高度
    source?: 'camera' | 'photos' | 'prompt';  // 默认 'prompt'
  }): Promise<{ base64?: string; dataUrl?: string; webPath?: string } | null> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/camera');
      if (mod) {
        try {
          const { Camera, CameraResultType, CameraSource } = mod;
          const sourceMap = {
            camera: CameraSource.Camera,
            photos: CameraSource.Photos,
            prompt: CameraSource.Prompt,
          };
          const photo = await Camera.getPhoto({
            quality: options?.quality ?? 80,
            width: options?.width,
            height: options?.height,
            resultType: CameraResultType.Base64,
            source: sourceMap[options?.source ?? 'prompt'] ?? CameraSource.Prompt,
            allowEditing: false,
          });
          return {
            base64: photo.base64String,
            dataUrl: photo.dataUrl,
            webPath: photo.webPath,
          };
        } catch (e: any) {
          // 用户取消拍照
          if (e?.message?.includes('cancel') || e?.message?.includes('Cancel')) {
            return null;
          }
          throw e;
        }
      }
    }

    // Web 降级
    const file = await webFilePicker('image/*', 'environment');
    if (!file) return null;
    const base64 = await fileToBase64(file);
    return {
      base64,
      dataUrl: `data:${file.type};base64,${base64}`,
    };
  },

  /**
   * 从相册选图
   */
  async pickImages(options?: {
    quality?: number;
    limit?: number;       // 最多选几张，默认 1
  }): Promise<Array<{ base64?: string; webPath?: string }>> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/camera');
      if (mod) {
        const { Camera } = mod;
        const result = await Camera.pickImages({
          quality: options?.quality ?? 80,
          limit: options?.limit ?? 1,
        });
        return result.photos.map((p: any) => ({
          base64: p.base64String,
          webPath: p.webPath,
        }));
      }
    }

    // Web 降级
    const file = await webFilePicker('image/*');
    if (!file) return [];
    const base64 = await fileToBase64(file);
    return [{ base64 }];
  },

  /**
   * 检查相机权限
   */
  async checkPermissions(): Promise<'granted' | 'denied' | 'prompt'> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/camera');
      if (mod) {
        const result = await mod.Camera.checkPermissions();
        return result.camera as 'granted' | 'denied' | 'prompt';
      }
    }
    // Web: 用 Permissions API
    try {
      const status = await navigator.permissions.query({ name: 'camera' as any });
      return status.state as 'granted' | 'denied' | 'prompt';
    } catch {
      return 'prompt';
    }
  },

  /** 原生拍照/相册结果 → data URL（处理 webPath / base64 / dataUrl） */
  photoToDataUrl: readNativePhotoToDataUrl,
};


// ── 地理定位 ─────────────────────────────────────────────────────────────
export const geo = {
  /**
   * 获取当前位置
   */
  async getCurrentPosition(options?: {
    enableHighAccuracy?: boolean;
    timeout?: number;
    maximumAge?: number;
  }): Promise<{ latitude: number; longitude: number; accuracy: number; timestamp: number } | null> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/geolocation');
      if (mod) {
        try {
          const pos = await mod.Geolocation.getCurrentPosition({
            enableHighAccuracy: options?.enableHighAccuracy ?? true,
            timeout: options?.timeout ?? 15000,
            maximumAge: options?.maximumAge ?? 0,
          });
          return {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
          };
        } catch {
          return null;
        }
      }
    }

    // Web 降级
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
        () => resolve(null),
        {
          enableHighAccuracy: options?.enableHighAccuracy ?? true,
          timeout: options?.timeout ?? 15000,
          maximumAge: options?.maximumAge ?? 0,
        },
      );
    });
  },

  /**
   * 监听位置变化
   * 返回取消监听的函数
   */
  async watchPosition(
    callback: (pos: { latitude: number; longitude: number; accuracy: number } | null) => void,
    options?: { enableHighAccuracy?: boolean },
  ): Promise<() => void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/geolocation');
      if (mod) {
        const watchId = await mod.Geolocation.watchPosition(
          { enableHighAccuracy: options?.enableHighAccuracy ?? true },
          (pos: any) => {
            if (pos) {
              callback({
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
              });
            } else {
              callback(null);
            }
          },
        );
        return () => { mod.Geolocation.clearWatch({ id: watchId }); };
      }
    }

    // Web 降级
    if (!navigator.geolocation) {
      return () => {};
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => callback({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      () => callback(null),
      { enableHighAccuracy: options?.enableHighAccuracy ?? true },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  },

  async checkPermissions(): Promise<'granted' | 'denied' | 'prompt'> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/geolocation');
      if (mod?.Geolocation?.checkPermissions) {
        try {
          const r = await mod.Geolocation.checkPermissions();
          const loc = r.location ?? r.coarseLocation ?? r.locationAlways;
          if (loc === 'granted') return 'granted';
          if (loc === 'denied') return 'denied';
          return 'prompt';
        } catch {
          return 'prompt';
        }
      }
    }
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      if (status.state === 'granted') return 'granted';
      if (status.state === 'denied') return 'denied';
      return 'prompt';
    } catch {
      return 'prompt';
    }
  },

  async requestPermissions(): Promise<'granted' | 'denied' | 'prompt'> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/geolocation');
      if (mod?.Geolocation?.requestPermissions) {
        try {
          const r = await mod.Geolocation.requestPermissions();
          const loc = r.location ?? r.coarseLocation ?? r.locationAlways;
          if (loc === 'granted') return 'granted';
          if (loc === 'denied') return 'denied';
          return 'prompt';
        } catch {
          return 'prompt';
        }
      }
    }
    const pos = await geo.getCurrentPosition({ enableHighAccuracy: false, timeout: 12000, maximumAge: 0 });
    return pos ? 'granted' : geo.checkPermissions();
  },
};


// ── 推送通知 ─────────────────────────────────────────────────────────────
export const pushNotifications = {
  /**
   * 注册推送通知
   * 返回设备 token（用于服务端发送定向推送）
   */
  async register(): Promise<{ token: string } | null> {
    if (!isNative()) return null;

    const mod = loadPlugin('@capacitor/push-notifications');
    if (!mod) return null;

    const { PushNotifications } = mod;

    // 检查/请求权限
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }
    if (permStatus.receive !== 'granted') return null;

    // 注册
    await PushNotifications.register();

    // 等待 token
    return new Promise((resolve) => {
      PushNotifications.addListener('registration', (token: any) => {
        resolve({ token: token.value });
      });
      PushNotifications.addListener('registrationError', () => {
        resolve(null);
      });
      // 超时兜底
      setTimeout(() => resolve(null), 10000);
    });
  },

  /**
   * 监听收到的推送
   */
  async onReceived(callback: (data: { title?: string; body?: string; data?: any }) => void): Promise<() => void> {
    if (!isNative()) return () => {};

    const mod = loadPlugin('@capacitor/push-notifications');
    if (!mod) return () => {};

    const handle = await mod.PushNotifications.addListener(
      'pushNotificationReceived',
      (notification: any) => {
        callback({
          title: notification.title,
          body: notification.body,
          data: notification.data,
        });
      },
    );
    return () => handle.remove();
  },

  /**
   * 监听用户点击推送
   */
  async onActionPerformed(callback: (data: { actionId: string; data?: any }) => void): Promise<() => void> {
    if (!isNative()) return () => {};

    const mod = loadPlugin('@capacitor/push-notifications');
    if (!mod) return () => {};

    const handle = await mod.PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action: any) => {
        callback({
          actionId: action.actionId,
          data: action.notification?.data,
        });
      },
    );
    return () => handle.remove();
  },
};


// ── 极光推送 JPush ──────────────────────────────────────────────────────
// 仅在启用 capacitor-plugin-jpush 的 Capacitor 原生构建中可用
export const jpush = {
  /**
   * 获取 JPush registration ID（用于服务端定向推送）
   */
  async getRegistrationId(): Promise<string | null> {
    if (!isNative()) return null;
    const mod = loadPlugin('capacitor-plugin-jpush');
    if (!mod) return null;
    try {
      const { JPush } = mod;
      const { registrationId } = await JPush.getRegistrationID();
      return registrationId || null;
    } catch { return null; }
  },

  /**
   * 启动极光推送服务（需先在 capacitor.config.ts 配置 appKey）
   */
  async start(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('capacitor-plugin-jpush');
    if (!mod) return;
    try {
      const { JPush } = mod;
      await JPush.startJPush();
    } catch { /* ignore */ }
  },

  /**
   * 设置推送别名（通常为用户ID）
   */
  async setAlias(alias: string): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('capacitor-plugin-jpush');
    if (!mod) return;
    try {
      const { JPush } = mod;
      await JPush.setAlias({ alias, sequence: 1 });
    } catch { /* ignore */ }
  },

  /**
   * 监听收到的推送通知（前台）
   */
  async onReceived(
    callback: (data: { title?: string; content?: string; rawData?: any }) => void,
  ): Promise<() => void> {
    if (!isNative()) return () => {};
    const mod = loadPlugin('capacitor-plugin-jpush');
    if (!mod) return () => {};
    try {
      const handle = await mod.JPush.addListener('notificationReceived', (data: any) => {
        callback({ title: data.title, content: data.content, rawData: data.rawData });
      });
      return () => handle.remove();
    } catch { return () => {}; }
  },

  /**
   * 监听用户点击推送通知
   */
  async onOpened(
    callback: (data: { title?: string; content?: string; rawData?: any }) => void,
  ): Promise<() => void> {
    if (!isNative()) return () => {};
    const mod = loadPlugin('capacitor-plugin-jpush');
    if (!mod) return () => {};
    try {
      const handle = await mod.JPush.addListener('notificationOpened', (data: any) => {
        callback({ title: data.title, content: data.content, rawData: data.rawData });
      });
      return () => handle.remove();
    } catch { return () => {}; }
  },
};


// ── 文件系统 ─────────────────────────────────────────────────────────────
export const filesystem = {
  /**
   * 写入文件
   */
  async writeFile(options: {
    path: string;
    data: string;          // base64 或文本
    directory?: 'Documents' | 'Data' | 'Cache' | 'External';
    encoding?: 'utf8';     // 不传 = base64 二进制
    recursive?: boolean;
  }): Promise<{ uri: string } | null> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/filesystem');
      if (mod) {
        const { Filesystem, Directory, Encoding } = mod;
        const dirMap: Record<string, any> = {
          Documents: Directory.Documents,
          Data: Directory.Data,
          Cache: Directory.Cache,
          External: Directory.External,
        };
        const result = await Filesystem.writeFile({
          path: options.path,
          data: options.data,
          directory: dirMap[options.directory ?? 'Documents'] ?? Directory.Documents,
          encoding: options.encoding ? Encoding.UTF8 : undefined,
          recursive: options.recursive ?? true,
        });
        return { uri: result.uri };
      }
    }

    // Web 降级：触发浏览器下载
    const blob = options.encoding
      ? new Blob([options.data], { type: 'text/plain' })
      : (() => {
        const binary = atob(options.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes]);
      })();

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = options.path.split('/').pop() || 'download';
    a.click();
    URL.revokeObjectURL(url);
    return { uri: url };
  },

  /**
   * 读取文件
   */
  async readFile(options: {
    path: string;
    directory?: 'Documents' | 'Data' | 'Cache' | 'External';
    encoding?: 'utf8';
  }): Promise<{ data: string } | null> {
    if (!isNative()) return null;

    const mod = loadPlugin('@capacitor/filesystem');
    if (!mod) return null;

    const { Filesystem, Directory, Encoding } = mod;
    const dirMap: Record<string, any> = {
      Documents: Directory.Documents,
      Data: Directory.Data,
      Cache: Directory.Cache,
      External: Directory.External,
    };
    try {
      const result = await Filesystem.readFile({
        path: options.path,
        directory: dirMap[options.directory ?? 'Documents'] ?? Directory.Documents,
        encoding: options.encoding ? Encoding.UTF8 : undefined,
      });
      return { data: result.data as string };
    } catch {
      return null;
    }
  },

  /**
   * 删除文件
   */
  async deleteFile(options: {
    path: string;
    directory?: 'Documents' | 'Data' | 'Cache' | 'External';
  }): Promise<boolean> {
    if (!isNative()) return false;

    const mod = loadPlugin('@capacitor/filesystem');
    if (!mod) return false;

    const { Filesystem, Directory } = mod;
    const dirMap: Record<string, any> = {
      Documents: Directory.Documents,
      Data: Directory.Data,
      Cache: Directory.Cache,
      External: Directory.External,
    };
    try {
      await Filesystem.deleteFile({
        path: options.path,
        directory: dirMap[options.directory ?? 'Documents'] ?? Directory.Documents,
      });
      return true;
    } catch {
      return false;
    }
  },
};


// ── 网络 ─────────────────────────────────────────────────────────────────
export const network = {
  /**
   * 获取当前网络状态
   */
  async getStatus(): Promise<{
    connected: boolean;
    connectionType: 'wifi' | 'cellular' | 'none' | 'unknown';
  }> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/network');
      if (mod) {
        const status = await mod.Network.getStatus();
        return {
          connected: status.connected,
          connectionType: status.connectionType as any,
        };
      }
    }

    // Web 降级
    return {
      connected: navigator.onLine,
      connectionType: navigator.onLine ? 'unknown' : 'none',
    };
  },

  /**
   * 监听网络变化
   */
  async onStatusChange(
    callback: (status: { connected: boolean; connectionType: string }) => void,
  ): Promise<() => void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/network');
      if (mod) {
        const handle = await mod.Network.addListener('networkStatusChange', (status: any) => {
          callback({
            connected: status.connected,
            connectionType: status.connectionType,
          });
        });
        return () => handle.remove();
      }
    }

    // Web 降级
    const onOnline = () => callback({ connected: true, connectionType: 'unknown' });
    const onOffline = () => callback({ connected: false, connectionType: 'none' });
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },
};


// ── 设备信息 ─────────────────────────────────────────────────────────────
export const device = {
  /**
   * 获取设备信息
   */
  async getInfo(): Promise<{
    model: string;
    platform: string;
    operatingSystem: string;
    osVersion: string;
    manufacturer: string;
    isVirtual: boolean;
    webViewVersion: string;
  }> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/device');
      if (mod) {
        const info = await mod.Device.getInfo();
        return {
          model: info.model,
          platform: info.platform,
          operatingSystem: info.operatingSystem,
          osVersion: info.osVersion,
          manufacturer: info.manufacturer,
          isVirtual: info.isVirtual,
          webViewVersion: info.webViewVersion,
        };
      }
    }

    // Web 降级
    return {
      model: 'unknown',
      platform: 'web',
      operatingSystem: navigator.platform || 'unknown',
      osVersion: 'unknown',
      manufacturer: 'unknown',
      isVirtual: false,
      webViewVersion: navigator.userAgent,
    };
  },

  /**
   * 获取设备唯一 ID
   */
  async getId(): Promise<string> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/device');
      if (mod) {
        const id = await mod.Device.getId();
        return id.identifier;
      }
    }

    // Web 降级：用 localStorage 模拟一个持久 ID
    const key = '__taproot_device_id__';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(key, id);
    }
    return id;
  },
};


// ── 本地存储（持久化） ───────────────────────────────────────────────────
export const preferences = {
  /**
   * 设置值
   */
  async set(key: string, value: string): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/preferences');
      if (mod) {
        await mod.Preferences.set({ key, value });
        return;
      }
    }
    localStorage.setItem(key, value);
  },

  /**
   * 获取值
   */
  async get(key: string): Promise<string | null> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/preferences');
      if (mod) {
        const result = await mod.Preferences.get({ key });
        return result.value;
      }
    }
    return localStorage.getItem(key);
  },

  /**
   * 删除值
   */
  async remove(key: string): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/preferences');
      if (mod) {
        await mod.Preferences.remove({ key });
        return;
      }
    }
    localStorage.removeItem(key);
  },

  /**
   * 清空所有
   */
  async clear(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/preferences');
      if (mod) {
        await mod.Preferences.clear();
        return;
      }
    }
    localStorage.clear();
  },
};


// ── 应用生命周期 ─────────────────────────────────────────────────────────
export const app = {
  /**
   * 监听前后台切换
   */
  async onStateChange(callback: (state: { isActive: boolean }) => void): Promise<() => void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/app');
      if (mod) {
        const handle = await mod.App.addListener('appStateChange', (state: any) => {
          callback({ isActive: state.isActive });
        });
        return () => handle.remove();
      }
    }

    // Web 降级
    const onVisChange = () => {
      callback({ isActive: !document.hidden });
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  },

  /**
   * 监听返回键（仅 Android）
   */
  async onBackButton(callback: () => void): Promise<() => void> {
    if (!isNative()) return () => {};

    const mod = loadPlugin('@capacitor/app');
    if (!mod) return () => {};

    const handle = await mod.App.addListener('backButton', () => {
      callback();
    });
    return () => handle.remove();
  },

  /**
   * Deep link / OAuth callback（Custom Tabs 回到 App 时触发 appUrlOpen）
   */
  async onAppUrlOpen(callback: (url: string) => void): Promise<() => void> {
    if (!isNative()) return () => {};

    const mod = loadPlugin('@capacitor/app');
    if (!mod) return () => {};

    const handle = await mod.App.addListener('appUrlOpen', (event: { url: string }) => {
      callback(event.url);
    });
    return () => handle.remove();
  },

  /** 冷启动时由 URL 打开 App（OAuth 回调可能走此路径） */
  async getLaunchUrl(): Promise<string | null> {
    if (!isNative()) return null;

    const mod = loadPlugin('@capacitor/app');
    if (!mod?.App?.getLaunchUrl) return null;

    try {
      const result = await mod.App.getLaunchUrl();
      return result?.url ?? null;
    } catch {
      return null;
    }
  },

  /**
   * 退出应用（仅 Android）
   */
  async exitApp(): Promise<void> {
    if (!isNative()) return;

    const mod = loadPlugin('@capacitor/app');
    if (mod) {
      await mod.App.exitApp();
    }
  },

  /**
   * 打开 URL / 深链（原生 App 插件或 Web window.open）
   */
  async openUrl(url: string): Promise<boolean> {
    const trimmed = url?.trim();
    if (!trimmed) return false;
    if (isNative()) {
      const mod = loadPlugin('@capacitor/app');
      if (mod?.App?.openUrl) {
        try {
          await mod.App.openUrl({ url: trimmed });
          return true;
        } catch {
          return false;
        }
      }
    }
    try {
      window.open(trimmed, '_blank', 'noopener');
      return true;
    } catch {
      return false;
    }
  },

  /**
   * 跳转系统应用权限设置（iOS / Android）
   */
  async openSystemSettings(): Promise<'opened' | 'web_hint'> {
    if (!isNative()) return 'web_hint';
    const mod = loadPlugin('@capacitor/app');
    const App = mod?.App;
    if (App?.openUrl) {
      try {
        const platform = getPlatform();
        if (platform === 'ios') {
          await App.openUrl({ url: 'app-settings:' });
          return 'opened';
        }
        let packageId = 'com.taprootagro.app';
        if (App.getInfo) {
          try {
            const info = await App.getInfo();
            if (info?.id) packageId = info.id;
          } catch {
            /* use default */
          }
        }
        const intentUrl = `intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;data=package:${packageId};end`;
        try {
          await App.openUrl({ url: intentUrl });
          return 'opened';
        } catch {
          await App.openUrl({ url: `package:${packageId}` });
          return 'opened';
        }
      } catch {
        /* fall through */
      }
    }
    try {
      window.location.href = 'app-settings:';
      return 'opened';
    } catch {
      return 'web_hint';
    }
  },

  /** Android 包名 / iOS bundle id（与 Fast Builder app_id、OAuth scheme 一致） */
  async getId(): Promise<string | null> {
    if (!isNative()) return null;
    const mod = loadPlugin('@capacitor/app');
    if (!mod?.App?.getInfo) return null;
    try {
      const info = await mod.App.getInfo();
      const id = typeof info?.id === 'string' ? info.id.trim() : '';
      return id || null;
    } catch {
      return null;
    }
  },
};


// ============================================================================
// 第二档：体验提升（9 个插件）
// ============================================================================

// ── 键盘 ─────────────────────────────────────────────────────────────────
export const keyboard = {
  async hide(): Promise<void> {
    if (!isNative()) {
      // Web 降级：blur 当前聚焦元素
      (document.activeElement as HTMLElement)?.blur?.();
      return;
    }
    const mod = loadPlugin('@capacitor/keyboard');
    if (mod) await mod.Keyboard.hide();
  },

  async onShow(callback: (info: { keyboardHeight: number }) => void): Promise<() => void> {
    if (!isNative()) return () => {};
    const mod = loadPlugin('@capacitor/keyboard');
    if (!mod) return () => {};
    const handle = await mod.Keyboard.addListener('keyboardDidShow', (info: any) => {
      callback({ keyboardHeight: info.keyboardHeight });
    });
    return () => handle.remove();
  },

  async onHide(callback: () => void): Promise<() => void> {
    if (!isNative()) return () => {};
    const mod = loadPlugin('@capacitor/keyboard');
    if (!mod) return () => {};
    const handle = await mod.Keyboard.addListener('keyboardDidHide', () => {
      callback();
    });
    return () => handle.remove();
  },
};


// ── 状态栏 ───────────────────────────────────────────────────────────────
export const statusBar = {
  async setStyle(style: 'dark' | 'light'): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/status-bar');
    if (mod) {
      await mod.StatusBar.setStyle({
        style: style === 'dark' ? mod.Style.Dark : mod.Style.Light,
      });
    }
  },

  async setBackgroundColor(color: string): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/status-bar');
    if (mod) await mod.StatusBar.setBackgroundColor({ color });
  },

  async hide(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/status-bar');
    if (mod) await mod.StatusBar.hide();
  },

  async show(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/status-bar');
    if (mod) await mod.StatusBar.show();
  },
};


// ── Android 底部手势导航条 ───────────────────────────────────────────────
export const navigationBar = {
  /** 与 Tab 栏一致的白色底 + 深色手势图标（仅 Android） */
  async setColor(color: string, darkButtons = true): Promise<void> {
    if (!isNative() || getPlatform() !== 'android') return;
    const mod = loadPlugin('@capgo/capacitor-navigation-bar');
    if (!mod?.NavigationBar?.setNavigationBarColor) return;
    await mod.NavigationBar.setNavigationBarColor({ color, darkButtons });
  },
};

/** 原生启动时同步顶部状态栏 + 底部手势条颜色（避免 Android 默认黑条） */
export async function applyNativeSystemChrome(): Promise<void> {
  if (!isNative()) return;
  try {
    await statusBar.setBackgroundColor('#059669');
    await statusBar.setStyle('dark');
  } catch {
    /* non-fatal */
  }
  try {
    await navigationBar.setColor('#FFFFFF', true);
  } catch {
    /* non-fatal */
  }
}


// ── 启动屏 ───────────────────────────────────────────────────────────────
export const splashScreen = {
  async hide(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/splash-screen');
    if (mod) await mod.SplashScreen.hide();
  },

  async show(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/splash-screen');
    if (mod) await mod.SplashScreen.show();
  },
};


// ── 震动反馈 ─────────────────────────────────────────────────────────────
export const haptics = {
  /** 轻触反馈 */
  async impact(style: 'light' | 'medium' | 'heavy' = 'medium'): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/haptics');
      if (mod) {
        const styleMap: Record<string, any> = {
          light: mod.ImpactStyle.Light,
          medium: mod.ImpactStyle.Medium,
          heavy: mod.ImpactStyle.Heavy,
        };
        await mod.Haptics.impact({ style: styleMap[style] });
        return;
      }
    }
    // Web 降级
    navigator.vibrate?.(style === 'light' ? 10 : style === 'medium' ? 20 : 30);
  },

  /** 通知类反馈（成功/警告/错误） */
  async notification(type: 'success' | 'warning' | 'error' = 'success'): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/haptics');
      if (mod) {
        const typeMap: Record<string, any> = {
          success: mod.NotificationType.Success,
          warning: mod.NotificationType.Warning,
          error: mod.NotificationType.Error,
        };
        await mod.Haptics.notification({ type: typeMap[type] });
        return;
      }
    }
    navigator.vibrate?.(type === 'error' ? [50, 50, 50] : 20);
  },

  /** 通用震动 */
  async vibrate(duration: number = 300): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/haptics');
      if (mod) {
        await mod.Haptics.vibrate({ duration });
        return;
      }
    }
    navigator.vibrate?.(duration);
  },
};


// ── 本地通知 ─────────────────────────────────────────────────────────────
export const localNotifications = {
  /**
   * 发送定时本地通知（浇水提醒、施肥提醒等）
   */
  async schedule(options: {
    id: number;
    title: string;
    body: string;
    scheduleAt?: Date;     // 不传 = 立即
    repeatEvery?: 'day' | 'week' | 'month';
    data?: Record<string, any>;
  }): Promise<boolean> {
    if (!isNative()) {
      // Web 降级：用 Notification API（不支持定时，只能立即发）
      if ('Notification' in window) {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
        if (Notification.permission === 'granted') {
          if (options.scheduleAt && options.scheduleAt > new Date()) {
            const delay = options.scheduleAt.getTime() - Date.now();
            setTimeout(() => {
              new Notification(options.title, { body: options.body });
            }, delay);
          } else {
            new Notification(options.title, { body: options.body });
          }
          return true;
        }
      }
      return false;
    }

    const mod = loadPlugin('@capacitor/local-notifications');
    if (!mod) return false;

    const { LocalNotifications } = mod;

    // 检查权限
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display === 'prompt') {
      perm = await LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') return false;

    const notification: any = {
      id: options.id,
      title: options.title,
      body: options.body,
      extra: options.data,
    };

    if (options.scheduleAt) {
      notification.schedule = {
        at: options.scheduleAt,
        repeats: !!options.repeatEvery,
        every: options.repeatEvery,
      };
    }

    await LocalNotifications.schedule({ notifications: [notification] });
    return true;
  },

  /**
   * 取消指定通知
   */
  async cancel(ids: number[]): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/local-notifications');
    if (mod) {
      await mod.LocalNotifications.cancel({
        notifications: ids.map((id) => ({ id })),
      });
    }
  },
};


// ── 分享 ─────────────────────────────────────────────────────────────────
export const share = {
  /**
   * 调用系统分享面板
   */
  async share(options: {
    title?: string;
    text?: string;
    url?: string;
    dialogTitle?: string;
  }): Promise<boolean> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/share');
      if (mod) {
        try {
          await mod.Share.share(options);
          return true;
        } catch {
          return false;
        }
      }
    }

    // Web 降级
    if (navigator.share) {
      try {
        await navigator.share({
          title: options.title,
          text: options.text,
          url: options.url,
        });
        return true;
      } catch {
        return false;
      }
    }

    // 最终降级：复制到剪贴板
    const content = options.url || options.text || '';
    if (content && navigator.clipboard) {
      await navigator.clipboard.writeText(content);
    }
    return false;
  },
};


// ── 剪贴 ───────────────────────────────────────────────────────────────
export const clipboard = {
  async write(text: string): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/clipboard');
      if (mod) {
        await mod.Clipboard.write({ string: text });
        return;
      }
    }
    await navigator.clipboard?.writeText(text);
  },

  async read(): Promise<string> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/clipboard');
      if (mod) {
        const result = await mod.Clipboard.read();
        return result.value;
      }
    }
    return (await navigator.clipboard?.readText()) || '';
  },
};


// ── 对话框 ───────────────────────────────────────────────────────────────
export const dialog = {
  async alert(options: { title: string; message: string; buttonTitle?: string }): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/dialog');
      if (mod) {
        await mod.Dialog.alert(options);
        return;
      }
    }
    window.alert(`${options.title}\n\n${options.message}`);
  },

  async confirm(options: {
    title: string;
    message: string;
    okButtonTitle?: string;
    cancelButtonTitle?: string;
  }): Promise<boolean> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/dialog');
      if (mod) {
        const result = await mod.Dialog.confirm(options);
        return result.value;
      }
    }
    return window.confirm(`${options.title}\n\n${options.message}`);
  },

  async prompt(options: {
    title: string;
    message: string;
    inputPlaceholder?: string;
    okButtonTitle?: string;
    cancelButtonTitle?: string;
  }): Promise<{ value: string; cancelled: boolean }> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/dialog');
      if (mod) {
        const result = await mod.Dialog.prompt(options);
        return { value: result.value, cancelled: result.cancelled };
      }
    }
    const result = window.prompt(`${options.title}\n\n${options.message}`, options.inputPlaceholder);
    return { value: result || '', cancelled: result === null };
  },
};


// ── Toast ────────────────────────────────────────────────────────────────
export const toast = {
  async show(options: { text: string; duration?: 'short' | 'long'; position?: 'top' | 'center' | 'bottom' }): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/toast');
      if (mod) {
        await mod.Toast.show(options);
        return;
      }
    }

    // Web 降级：简单的 DOM toast
    const el = document.createElement('div');
    el.textContent = options.text;
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      transform: 'translateX(-50%)',
      [options.position === 'top' ? 'top' : 'bottom']: '80px',
      padding: '12px 24px',
      background: 'rgba(0,0,0,0.8)',
      color: '#fff',
      borderRadius: '8px',
      zIndex: '99999',
      fontSize: '14px',
      transition: 'opacity 0.3s',
    });
    document.body.appendChild(el);
    const dur = options.duration === 'long' ? 3500 : 2000;
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, dur);
  },
};


// ============================================================================
// 第三档：增强功能（10 个插件）
// ============================================================================

// ── 二维码扫描 ───────────────────────────────────────────────────────────
// @capacitor-community/barcode-scanner 把相机预览画在 WebView 后面。
// 必须 hideBackground + 把页面做成透明，否则用户只看到黑屏转圈，
// 而 startScan() 会一直等到扫到码才 resolve。
const QR_SCANNER_ACTIVE_CLASS = 'qr-scanner-active';

function resolveBarcodeScanner(mod: any): any | null {
  return mod?.BarcodeScanner ?? mod?.default?.BarcodeScanner ?? null;
}

function setQrScannerChrome(active: boolean) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(QR_SCANNER_ACTIVE_CLASS, active);
  document.body.classList.toggle(QR_SCANNER_ACTIVE_CLASS, active);
}

async function restoreBarcodeScannerBackground(BarcodeScanner: any | null) {
  try {
    if (BarcodeScanner && typeof BarcodeScanner.showBackground === 'function') {
      await BarcodeScanner.showBackground();
    }
  } catch { /* ignore */ }
  setQrScannerChrome(false);
}

export const barcodeScanner = {
  async scan(): Promise<{ content: string; format: string } | null> {
    if (!isNative()) return null; // Web 端无降级方案（需要第三方库）

    const mod = loadPlugin('@capacitor-community/barcode-scanner');
    const BarcodeScanner = resolveBarcodeScanner(mod);
    if (!BarcodeScanner || typeof BarcodeScanner.startScan !== 'function') return null;
    // hideBackground 缺失时不要挂起 startScan：相机会在不透明 WebView 后空转
    if (typeof BarcodeScanner.hideBackground !== 'function') return null;

    const status = await BarcodeScanner.checkPermission({ force: true });
    if (!status.granted) return null;

    setQrScannerChrome(true);
    try {
      await BarcodeScanner.hideBackground();
      const result = await BarcodeScanner.startScan();
      if (result.hasContent) {
        return { content: result.content!, format: result.format || 'unknown' };
      }
      return null;
    } catch {
      return null;
    } finally {
      await restoreBarcodeScannerBackground(BarcodeScanner);
    }
  },

  async stopScan(): Promise<void> {
    if (!isNative()) return;
    const BarcodeScanner = resolveBarcodeScanner(
      loadPlugin('@capacitor-community/barcode-scanner'),
    );
    try {
      if (BarcodeScanner && typeof BarcodeScanner.stopScan === 'function') {
        await BarcodeScanner.stopScan();
      }
    } catch { /* ignore */ }
    await restoreBarcodeScannerBackground(BarcodeScanner);
  },

  async setTorch(on: boolean): Promise<boolean> {
    if (!isNative()) return false;
    const BarcodeScanner = resolveBarcodeScanner(
      loadPlugin('@capacitor-community/barcode-scanner'),
    );
    if (!BarcodeScanner) return false;
    try {
      if (on && typeof BarcodeScanner.enableTorch === 'function') {
        await BarcodeScanner.enableTorch();
        return true;
      }
      if (!on && typeof BarcodeScanner.disableTorch === 'function') {
        await BarcodeScanner.disableTorch();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  },
};


// ── 语音识别（语音转文字） ───────────────────────────────────────────────
export type WebSpeechHoldSession = {
  /** 松手调用：结束识别并返回最终文本候选（通常取 [0]） */
  stop: () => Promise<string[]>;
  /** 取消（上滑取消等）：不等待结果 */
  abort: () => void;
};

export const speechRecognition = {
  /**
   * 开始语音识别
   * 适用场景：不识字的农民用语音输入
   */
  async start(options?: {
    language?: string;      // 如 'zh-CN', 'sw-TZ', 'hi-IN'
    maxResults?: number;
    popup?: boolean;        // 是否显示系统识别 UI
  }): Promise<string[]> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/speech-recognition');
      if (mod) {
        const { SpeechRecognition } = mod;

        // 检查可用性和权限
        const available = await SpeechRecognition.available();
        if (!available.available) return [];

        const perm = await SpeechRecognition.requestPermissions();
        if (perm.speechRecognition !== 'granted') return [];

        const result = await SpeechRecognition.start({
          language: options?.language || 'zh-CN',
          maxResults: options?.maxResults || 5,
          popup: options?.popup ?? true,
        });
        return result.matches || [];
      }
    }

    // Web 降级：Web Speech API（Chrome/Edge 支持）
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      return [];
    }

    return new Promise((resolve) => {
      const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      const recognition = new SpeechRecognitionAPI();
      recognition.lang = options?.language || 'zh-CN';
      recognition.maxAlternatives = options?.maxResults || 5;

      recognition.onresult = (event: any) => {
        const results: string[] = [];
        for (let i = 0; i < event.results.length; i++) {
          for (let j = 0; j < event.results[i].length; j++) {
            results.push(event.results[i][j].transcript);
          }
        }
        resolve(results);
      };

      recognition.onerror = () => resolve([]);
      recognition.onend = () => {}; // onresult 已处理
      recognition.start();

      // 超时兜底
      setTimeout(() => {
        recognition.stop();
      }, 30000);
    });
  },

  /**
   * Web only：按住说话 — pointerdown 创建并开始识别，pointerup 调用 stop()。
   * App 模式请用原生 start()（松手后调一次）。
   */
  startWebHoldSession(options?: {
    language?: string;
    maxResults?: number;
  }): WebSpeechHoldSession | null {
    if (isNative()) return null;
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      return null;
    }

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionAPI();
    recognition.lang = options?.language || 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = options?.maxResults || 5;

    let transcript = '';
    // Chrome/Edge 在短句或安静结尾时经常 onend 前都不给 isFinal 结果，
    // 这里保留最近一次 interim 段作为兜底，避免返回空字符串。
    let lastInterim = '';
    let settled = false;
    let resolveStop: (v: string[]) => void = () => {};
    const stopPromise = new Promise<string[]>((r) => {
      resolveStop = r;
    });

    const finish = (results: string[]) => {
      if (settled) return;
      settled = true;
      resolveStop(results);
    };

    const pickTranscript = (): string => {
      const t = transcript.trim();
      if (t) return t;
      return lastInterim.trim();
    };

    recognition.onresult = (event: any) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) {
          finalChunk += piece;
        } else {
          interimChunk += piece;
        }
      }
      if (finalChunk) {
        transcript = (transcript + finalChunk).trim();
      }
      if (interimChunk) {
        lastInterim = interimChunk.trim();
      }
    };

    let aborted = false;

    recognition.onerror = (event: any) => {
      console.warn('[WebSpeech] onerror', event?.error || event);
      finish([]);
    };

    recognition.onend = () => {
      if (settled) return;
      if (aborted) {
        finish([]);
        return;
      }
      const t = pickTranscript();
      finish(t ? [t] : []);
    };

    try {
      recognition.start();
    } catch {
      return null;
    }

    return {
      stop: () => {
        if (settled) return stopPromise;
        try {
          recognition.stop();
        } catch {
          const t = pickTranscript();
          finish(t ? [t] : []);
        }
        return stopPromise;
      },
      abort: () => {
        if (settled) return;
        aborted = true;
        try {
          recognition.abort();
        } catch {
          finish([]);
        }
      },
    };
  },

  async stop(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor-community/speech-recognition');
    if (mod) await mod.SpeechRecognition.stop();
  },

  /** 检查是否支持 */
  async isAvailable(): Promise<boolean> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/speech-recognition');
      if (mod) {
        const result = await mod.SpeechRecognition.available();
        return result.available;
      }
    }
    return ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
  },
};


// ── 文字转语音（朗读） ───────────────────────────────────────────────────
let cachedNativeVoices: VoiceLike[] | null = null;
let nativeVoicesReadyPromise: Promise<VoiceLike[]> | null = null;

async function loadVoicesNative(): Promise<VoiceLike[]> {
  if (!isNative()) return [];
  if (cachedNativeVoices && cachedNativeVoices.length > 0) {
    return cachedNativeVoices;
  }
  if (nativeVoicesReadyPromise) return nativeVoicesReadyPromise;

  nativeVoicesReadyPromise = (async () => {
    const mod = loadPlugin('@capacitor-community/text-to-speech');
    if (!mod?.TextToSpeech?.getSupportedVoices) return [];
    try {
      const result = await mod.TextToSpeech.getSupportedVoices();
      const list: VoiceLike[] = result?.voices ?? [];
      cachedNativeVoices = list;
      return list;
    } catch {
      return [];
    }
  })();

  return nativeVoicesReadyPromise;
}

async function resolveTtsVoice(
  langTags: string[],
): Promise<ResolvedVoice | null> {
  if (isNative()) {
    const voices = await loadVoicesNative();
    return resolveVoiceForLang(voices, langTags);
  }
  const voices = await loadVoicesWeb();
  return resolveVoiceForLang(voices, langTags);
}

/** Warm voice lists for Web and native (call on app startup). */
export async function preloadVoices(): Promise<void> {
  await preloadVoicesWeb();
  if (isNative()) await loadVoicesNative();
}

function splitIntoChunks(text: string, maxLen = 180): string[] {
  const src = text.trim();
  if (!src) return [];
  if (src.length <= maxLen) return [src];

  // 先按"强断点"（段落换行、句末标点）切；再对超长片段按 , ; 再切；最后按长度兜底硬切。
  const strongBreakRe = /([^。！？!?\.\n\r]+[。！？!?\.\n\r]+|[^。！？!?\.\n\r]+$)/g;
  const initial: string[] = (src.match(strongBreakRe) || [src]).map((s) => s.trim()).filter(Boolean);

  const softSplit = (chunk: string): string[] => {
    if (chunk.length <= maxLen) return [chunk];
    const parts = chunk.split(/(?<=[，,；;：:])\s*/g).map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
      if (p.length <= maxLen) {
        out.push(p);
      } else {
        // 硬切：按 maxLen
        for (let i = 0; i < p.length; i += maxLen) {
          out.push(p.slice(i, i + maxLen));
        }
      }
    }
    return out;
  };

  const result: string[] = [];
  let buffer = '';
  for (const piece of initial) {
    const candidate = buffer ? buffer + piece : piece;
    if (candidate.length <= maxLen) {
      buffer = candidate;
    } else {
      if (buffer) {
        result.push(buffer);
        buffer = '';
      }
      if (piece.length <= maxLen) {
        buffer = piece;
      } else {
        result.push(...softSplit(piece));
      }
    }
  }
  if (buffer) result.push(buffer);
  return result;
}

export const textToSpeech = {
  /**
   * 朗读一段文字。
   * - App: 优先 @capacitor-community/text-to-speech 原生插件（Android WebView 的
   *   speechSynthesis 极不稳定，必须走原生）。
   * - Web: speechSynthesis + getBestVoice(lang)，确保 utterance.voice/lang 正确挑选。
   *
   * lang 必填：BCP-47 tag（如 'zh-CN'、'en-US'），由调用方通过 languageToSpeechTag
   * 从当前 UI 语言换算得到。
   */
  async speak(options: {
    text: string;
    lang: string;          // BCP-47, 必填
    langFallbacks?: string[];
    rate?: number;         // 语速 0.1-3.0, 默认 1.0
    pitch?: number;        // 音调 0.1-2.0, 默认 1.0
    volume?: number;       // 音量 0.0-1.0, 默认 1.0
    _resolved?: ResolvedVoice | null;
  }): Promise<void> {
    const text = options.text?.trim();
    if (!text) return;

    const langTags = options.langFallbacks?.length
      ? options.langFallbacks
      : [options.lang];
    const resolved = options._resolved ?? await resolveTtsVoice(langTags);
    if (!resolved) return;

    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/text-to-speech');
      if (mod?.TextToSpeech?.speak) {
        const payload: Record<string, unknown> = {
          text,
          lang: resolved.lang,
          rate: options.rate ?? 1.0,
          pitch: options.pitch ?? 1.0,
          volume: options.volume ?? 1.0,
          voice: resolved.voiceIndex,
        };
        if (getPlatform() === 'ios') payload.category = 'playback';
        await mod.TextToSpeech.speak(payload);
        return;
      }
    }

    if (!('speechSynthesis' in window)) return;

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = resolved.lang;
      utterance.voice = resolved.voice as SpeechSynthesisVoice;
      utterance.rate = options.rate ?? 1.0;
      utterance.pitch = options.pitch ?? 1.0;
      utterance.volume = options.volume ?? 1.0;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        resolve();
      }
    });
  },

  /**
   * 把长文本按句号 / 问号 / 换行切成 ≤ maxLen 的 chunk 串播；单句失败不终止队列。
   * 支持 AbortSignal 中途打断。整段朗读复用同一 resolved voice。
   */
  async speakQueue(
    text: string,
    opts: {
      lang: string;
      langFallbacks?: string[];
      rate?: number;
      pitch?: number;
      volume?: number;
      signal?: AbortSignal;
      maxLen?: number;
    },
  ): Promise<void> {
    if (opts.signal?.aborted) return;
    const langTags = opts.langFallbacks?.length ? opts.langFallbacks : [opts.lang];
    const resolved = await resolveTtsVoice(langTags);
    if (!resolved) return;

    const chunks = splitIntoChunks(text, opts.maxLen ?? 180);
    for (const chunk of chunks) {
      if (opts.signal?.aborted) return;
      try {
        await this.speak({
          text: chunk,
          lang: resolved.lang,
          langFallbacks: langTags,
          rate: opts.rate,
          pitch: opts.pitch,
          volume: opts.volume,
          _resolved: resolved,
        });
      } catch {
        // 单 chunk 失败继续下一个（Chrome 长 utterance 常 abort）
      }
    }
  },

  async stop(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/text-to-speech');
      if (mod?.TextToSpeech?.stop) {
        try { await mod.TextToSpeech.stop(); } catch { /* ignore */ }
        return;
      }
    }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  },

  async pause(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/text-to-speech');
      // 插件通常没有 pause（不标准），在原生侧只能 stop
      if (mod?.TextToSpeech?.pause) {
        try { await mod.TextToSpeech.pause(); return; } catch { /* fallthrough */ }
      }
      if (mod?.TextToSpeech?.stop) {
        try { await mod.TextToSpeech.stop(); } catch { /* ignore */ }
      }
      return;
    }
    try { window.speechSynthesis?.pause(); } catch { /* ignore */ }
  },

  async resume(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/text-to-speech');
      if (mod?.TextToSpeech?.resume) {
        try { await mod.TextToSpeech.resume(); } catch { /* ignore */ }
      }
      return;
    }
    try { window.speechSynthesis?.resume(); } catch { /* ignore */ }
  },

  async isSpeaking(): Promise<boolean> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/text-to-speech');
      if (mod?.TextToSpeech?.isSpeaking) {
        try {
          const r = await mod.TextToSpeech.isSpeaking();
          return !!(r && (r.value ?? r));
        } catch { /* ignore */ }
      }
      return false;
    }
    return !!window.speechSynthesis?.speaking;
  },

  /**
   * 当前环境是否具备可用 TTS 能力（App 下 plugin 已注册 / Web 下 speechSynthesis 可用）
   */
  isAvailable(): boolean {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/text-to-speech');
      return !!mod?.TextToSpeech?.speak;
    }
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  },
};


// ── 原生音频 ─────────────────────────────────────────────────────────────
export const nativeAudio = {
  async preload(options: { assetId: string; assetPath: string; volume?: number }): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor-community/native-audio');
    if (mod) {
      await mod.NativeAudio.preload({
        assetId: options.assetId,
        assetPath: options.assetPath,
        audioChannelNum: 1,
        volume: options.volume ?? 1.0,
        isUrl: false,
      });
    }
  },

  async play(assetId: string): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor-community/native-audio');
    if (mod) await mod.NativeAudio.play({ assetId });
  },

  async stop(assetId: string): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor-community/native-audio');
    if (mod) await mod.NativeAudio.stop({ assetId });
  },
};


// ── 屏幕方向 ─────────────────────────────────────────────────────────────
export const screenOrientation = {
  async lock(orientation: 'portrait' | 'landscape'): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/screen-orientation');
      if (mod) {
        await mod.ScreenOrientation.lock({
          orientation: orientation === 'portrait' ? 'portrait' : 'landscape',
        });
        return;
      }
    }
    // Web 降级
    try {
      await (screen.orientation as any)?.lock?.(orientation === 'portrait' ? 'portrait-primary' : 'landscape-primary');
    } catch { /* 大多数浏览器不支持 */ }
  },

  async unlock(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/screen-orientation');
      if (mod) {
        await mod.ScreenOrientation.unlock();
        return;
      }
    }
    try {
      (screen.orientation as any)?.unlock?.();
    } catch { /* ignore */ }
  },
};


// ── 应用内浏览器 ─────────────────────────────────────────────────────────
export const browser = {
  async open(url: string): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor/browser');
      if (mod) {
        await mod.Browser.open({ url });
        return;
      }
    }
    window.open(url, '_blank', 'noopener');
  },

  async close(): Promise<void> {
    if (!isNative()) return;
    const mod = loadPlugin('@capacitor/browser');
    if (mod) await mod.Browser.close();
  },
};


// ── 底部操作菜单 ─────────────────────────────────────────────────────────
export const actionSheet = {
  async showActions(options: {
    title?: string;
    actions: Array<{ title: string; style?: 'default' | 'destructive' | 'cancel' }>;
  }): Promise<number> {  // 返回选中的 index
    if (isNative()) {
      const mod = loadPlugin('@capacitor/action-sheet');
      if (mod) {
        const result = await mod.ActionSheet.showActions({
          title: options.title || '',
          options: options.actions.map((a) => ({
            title: a.title,
            style: a.style === 'destructive'
              ? mod.ActionSheetButtonStyle.Destructive
              : a.style === 'cancel'
                ? mod.ActionSheetButtonStyle.Cancel
                : mod.ActionSheetButtonStyle.Default,
          })),
        });
        return result.index;
      }
    }

    // Web 降级：简单的 prompt
    const msg = options.actions
      .map((a, i) => `${i + 1}. ${a.title}`)
      .join('\n');
    const choice = window.prompt(`${options.title || ''}\n\n${msg}\n\n输入编号：`);
    return choice ? parseInt(choice, 10) - 1 : -1;
  },
};


// ── 保持屏幕常亮 ─────────────────────────────────────────────────────────
export const keepAwake = {
  async enable(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/keep-awake');
      if (mod) {
        await mod.KeepAwake.keepAwake();
        return;
      }
    }
    // Web 降级：Wake Lock API（Chrome 84+）
    try {
      (navigator as any).__wakeLock = await (navigator as any).wakeLock?.request('screen');
    } catch { /* 不支持或用户拒绝 */ }
  },

  async disable(): Promise<void> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/keep-awake');
      if (mod) {
        await mod.KeepAwake.allowSleep();
        return;
      }
    }
    try {
      await (navigator as any).__wakeLock?.release();
      (navigator as any).__wakeLock = null;
    } catch { /* ignore */ }
  },
};


// ── 文件打开器 ───────────────────────────────────────────────────────────
export const fileOpener = {
  async open(options: { filePath: string; contentType: string }): Promise<boolean> {
    if (isNative()) {
      const mod = loadPlugin('@capacitor-community/file-opener');
      if (mod) {
        try {
          await mod.FileOpener.open({
            filePath: options.filePath,
            contentType: options.contentType,
          });
          return true;
        } catch {
          return false;
        }
      }
    }

    // Web 降级：直接在新标签打开
    window.open(options.filePath, '_blank');
    return true;
  },
};


// ── 通讯录 ───────────────────────────────────────────────────────────────
export const contacts = {
  async getContacts(): Promise<Array<{ name: string; phones: string[] }>> {
    if (!isNative()) {
      // Web: Contact Picker API（Chrome Android 80+，实验性）
      if ('contacts' in navigator && 'ContactsManager' in window) {
        try {
          const results = await (navigator as any).contacts.select(
            ['name', 'tel'],
            { multiple: true },
          );
          return results.map((c: any) => ({
            name: c.name?.[0] || '',
            phones: c.tel || [],
          }));
        } catch {
          return [];
        }
      }
      return [];
    }

    const mod = loadPlugin('@capacitor-community/contacts');
    if (!mod) return [];

    try {
      const result = await mod.Contacts.getContacts({
        projection: { name: true, phones: true },
      });
      return (result.contacts || []).map((c: any) => ({
        name: c.name?.display || '',
        phones: (c.phones || []).map((p: any) => p.number || ''),
      }));
    } catch {
      return [];
    }
  },
};


// ============================================================================
// 微信 / 支付宝 — 原生授权（Capacitor 环境）
// ============================================================================

/**
 * 通过 Capacitor 微信插件获取授权 code。
 *
 * 使用 Capacitor 环境时调用原生微信 SDK 发起授权，
 * 拿到 code 后由前端调用 exchangeRegionalOAuthCode() 换 Supabase 会话。
 *
 * 插件选择（按优先级尝试）：
 *   1. @capacitor-community/wechat  — 社区维护的 Capacitor 微信插件
 *   2. 自定义插件注入 window.__CAP_WECHAT_AUTH__  — 备用注入通道
 *
 * @param appId 微信 AppID（公开）
 * @returns 微信 OAuth2 authorization code
 */
const wechatAuth = async (appId: string): Promise<string> => {
  if (!isNative()) {
    throw new Error('WeChat native auth is only available in Capacitor environment');
  }

  // 方式 1：@capacitor-community/wechat 插件
  const mod = loadPlugin('@capacitor-community/wechat');
  if (mod) {
    try {
      const result = await mod.Wechat.auth({
        appId,
        scope: 'snsapi_userinfo',
        state: 'wechat',
      });
      if (result?.code) return result.code;
    } catch (e: any) {
      // 用户取消授权时 WeChat SDK 可能抛错，向上传递
      throw new Error(e?.message || 'WeChat auth cancelled');
    }
  }

  // 方式 2：自定义注入（window.__CAP_WECHAT_AUTH__）
  const injected = (window as any).__CAP_WECHAT_AUTH__;
  if (typeof injected?.auth === 'function') {
    try {
      const result = await injected.auth(appId, 'snsapi_userinfo', 'wechat');
      if (result?.code) return result.code;
    } catch (e: any) {
      throw new Error(e?.message || 'WeChat auth cancelled');
    }
  }

  throw new Error('WeChat plugin not available. Install @capacitor-community/wechat or inject window.__CAP_WECHAT_AUTH__');
};

/**
 * 通过 Capacitor 支付宝插件获取授权 auth_code。
 * 预留接口，与微信逻辑对称。
 */
const alipayAuth = async (_appId: string): Promise<string> => {
  if (!isNative()) {
    throw new Error('Alipay native auth is only available in Capacitor environment');
  }
  const mod = loadPlugin('@capacitor-community/alipay');
  if (mod) {
    try {
      const result = await mod.Alipay.auth({ appId: _appId });
      if (result?.auth_code) return result.auth_code;
    } catch (e: any) {
      throw new Error(e?.message || 'Alipay auth cancelled');
    }
  }
  throw new Error('Alipay plugin not available');
};

/**
 * 通过 Capacitor LINE 插件获取授权 code。
 *
 * LINE Login v2.1: 客户端（原生 SDK）发起授权 → 获取 code →
 * 调用此函数 → 前端再用 exchangeRegionalOAuthCode('line', code) 换 Supabase 会话。
 *
 * 插件选择（按优先级尝试）：
 *   1. @capacitor-community/line-login  — 社区 Capacitor LINE 插件
 *   2. window.__CAP_LINE_AUTH__           — 自定义注入通道
 *
 * @param channelId LINE Login channel ID（公开）
 * @returns LINE OAuth2 authorization code
 */
const lineAuth = async (channelId: string): Promise<string> => {
  if (!isNative()) {
    throw new Error('LINE native auth is only available in Capacitor environment');
  }

  const mod = loadPlugin('@capacitor-community/line-login');
  if (mod) {
    try {
      const result = await mod.LineLogin.login({
        channelId,
        scopes: ['profile'],
      });
      if (result?.code) return result.code;
    } catch (e: any) {
      throw new Error(e?.message || 'LINE auth cancelled');
    }
  }

  // Fallback: custom injection
  const injected = (window as any).__CAP_LINE_AUTH__;
  if (typeof injected?.login === 'function') {
    try {
      const result = await injected.login(channelId, ['profile']);
      if (result?.code) return result.code;
    } catch (e: any) {
      throw new Error(e?.message || 'LINE auth cancelled');
    }
  }

  throw new Error('LINE plugin not available. Install @capacitor-community/line-login or inject window.__CAP_LINE_AUTH__');
};

/**
 * 统一的 bridge 对象，按功能分组
 *
 * 使用示例：
 *
 *   import { bridge } from './utils/capacitor-bridge';
 *
 *   // 拍照
 *   const photo = await bridge.camera.takePhoto({ quality: 90 });
 *
 *   // GPS
 *   const pos = await bridge.geo.getCurrentPosition();
 *
 *   // 震动反馈
 *   await bridge.haptics.impact('light');
 *
 *   // 检测平台
 *   if (bridge.isNative()) {
 *     // 原生特有逻辑
 *   }
 */
export const bridge = {
  // 平台检测
  isNative,
  getPlatform,

  // 第一档：核心
  camera,
  geo,
  pushNotifications,
  filesystem,
  network,
  device,
  preferences,
  app,

  // 第二档：体验
  keyboard,
  statusBar,
  navigationBar,
  applyNativeSystemChrome,
  splashScreen,
  haptics,
  localNotifications,
  share,
  clipboard,
  dialog,
  toast,

  // 第三档：增强
  barcodeScanner,
  speechRecognition,
  textToSpeech,
  nativeAudio,
  screenOrientation,
  browser,
  actionSheet,
  keepAwake,
  fileOpener,
  contacts,

  // 第四档：第三方授权（微信 / 支付宝 / LINE）
  wechatAuth,
  alipayAuth,
  lineAuth,
} as const;

export default bridge;