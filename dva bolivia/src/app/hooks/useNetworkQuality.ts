import { useState, useEffect, useCallback } from 'react';

/**
 * 网络质量感知 Hook
 * 
 * 使用 navigator.connection (Network Information API) 检测弱网环境，
 * 自动降级图片质量、禁用动画等，提升全球农户在 2G/3G 下的使用体验。
 * 
 * 降级策略：
 *   - slow-2g / 2g: 极度降级（小图、无动画、无blur、无视频预载）
 *   - 3g: 中度降级（中等图片、简化动画）
 *   - 4g / wifi / unknown: 不降级
 */

export type NetworkTier = 'slow' | 'medium' | 'fast';

export interface NetworkQuality {
  /** 网络分级 */
  tier: NetworkTier;
  /** 是否在线 */
  online: boolean;
  /** 是否低端设备（CPU核心<=4 或 内存<=2GB） */
  isLowEndDevice: boolean;
  /** 是否应该降级（弱网 OR 低端设备） */
  shouldDegrade: boolean;
  /** 推荐的图片宽度参数 */
  imageWidth: number;
  /** 推荐的图片质量参数 */
  imageQuality: number;
  /** 是否禁用 backdrop-blur */
  disableBlur: boolean;
  /** 是否禁用自动播放（轮播/视频） */
  disableAutoplay: boolean;
  /** Unsplash 图片 URL 优化后缀 */
  imageSuffix: string;
}

function getEffectiveType(): string {
  const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
  return conn?.effectiveType || '4g';
}

function getSaveData(): boolean {
  const conn = (navigator as any).connection;
  return conn?.saveData === true;
}

function detectLowEndDevice(): boolean {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as any).deviceMemory || 4; // GB
  return cores <= 4 || memory <= 2;
}

function computeQuality(effectiveType: string, saveData: boolean, isLowEnd: boolean, online: boolean): NetworkQuality {
  const isOffline = !online;
  
  // 用户开启了"节省流量"
  if (saveData) {
    return {
      tier: 'slow',
      online,
      isLowEndDevice: isLowEnd,
      shouldDegrade: true,
      imageWidth: 320,
      imageQuality: 40,
      disableBlur: true,
      disableAutoplay: true,
      imageSuffix: '&w=320&q=40&fm=webp',
    };
  }

  switch (effectiveType) {
    case 'slow-2g':
    case '2g':
      return {
        tier: 'slow',
        online,
        isLowEndDevice: isLowEnd,
        shouldDegrade: true,
        imageWidth: 320,
        imageQuality: 40,
        disableBlur: true,
        disableAutoplay: true,
        imageSuffix: '&w=320&q=40&fm=webp',
      };
    case '3g':
      return {
        tier: 'medium',
        online,
        isLowEndDevice: isLowEnd,
        shouldDegrade: true,
        imageWidth: 480,
        imageQuality: 60,
        disableBlur: isLowEnd,
        disableAutoplay: false,
        imageSuffix: '&w=480&q=60&fm=webp',
      };
    default: // 4g, wifi, or unknown
      return {
        tier: 'fast',
        online,
        isLowEndDevice: isLowEnd,
        shouldDegrade: isLowEnd, // 仅低端设备降级
        imageWidth: 640,
        imageQuality: 75,
        disableBlur: isLowEnd,
        disableAutoplay: false,
        imageSuffix: '&w=640&q=75&fm=webp',
      };
  }
}

export function useNetworkQuality(): NetworkQuality {
  const [quality, setQuality] = useState<NetworkQuality>(() => {
    const isLowEnd = detectLowEndDevice();
    return computeQuality(getEffectiveType(), getSaveData(), isLowEnd, navigator.onLine);
  });

  const update = useCallback(() => {
    const isLowEnd = detectLowEndDevice();
    setQuality(computeQuality(getEffectiveType(), getSaveData(), isLowEnd, navigator.onLine));
  }, []);

  useEffect(() => {
    const conn = (navigator as any).connection;
    
    // 监听网络类型变化
    conn?.addEventListener?.('change', update);
    
    // 监听在线/离线
    window.addEventListener('online', update);
    window.addEventListener('offline', update);

    return () => {
      conn?.removeEventListener?.('change', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [update]);

  return quality;
}