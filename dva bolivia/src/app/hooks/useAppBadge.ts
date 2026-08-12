import { useEffect } from 'react';

/**
 * App Badge Hook - 用于管理PWA应用图标上的未读消息徽章
 * 支持Badging API，在桌面和移动设备的PWA图标上显示未读数字
 * 
 * 注意：document.title 由 useDynamicManifest 统一管理，
 * 此处不再操纵 document.title，避免两个 hook 互相覆盖。
 */
export function useAppBadge(count: number) {
  useEffect(() => {
    // 检查浏览器是否支持Badging API
    if ('setAppBadge' in navigator) {
      if (count > 0) {
        // 设置徽章数字
        navigator.setAppBadge(count).catch((error) => {
          console.log('设置应用徽章失败:', error);
        });
      } else {
        // 清除徽章
        navigator.clearAppBadge().catch((error) => {
          console.log('清除应用徽章失败:', error);
        });
      }
    }

    // 清理函数：组件卸载时清除徽章
    return () => {
      if ('clearAppBadge' in navigator && count > 0) {
        navigator.clearAppBadge().catch(() => {});
      }
    };
  }, [count]);
}

/**
 * 手动设置应用徽章
 */
export function setAppBadge(count: number) {
  if ('setAppBadge' in navigator) {
    navigator.setAppBadge(count).catch((error) => {
      console.log('设置应用徽章失败:', error);
    });
  }
}

/**
 * 手动清除应用徽章
 */
export function clearAppBadge() {
  if ('clearAppBadge' in navigator) {
    navigator.clearAppBadge().catch((error) => {
      console.log('清除应用徽章失败:', error);
    });
  }
}
