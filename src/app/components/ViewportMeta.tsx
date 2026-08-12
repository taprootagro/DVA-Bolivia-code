import { useEffect } from 'react';

/**
 * ViewportMeta - 仅负责 viewport 设置
 * 
 * 注意：theme-color, apple-mobile-web-app-capable, apple-mobile-web-app-status-bar-style
 * 由 PWARegister.tsx 统一管理，此处不再重复设置，避免冲突。
 */
export function ViewportMeta() {
  useEffect(() => {
    // 设置viewport meta标签
    let metaViewport = document.querySelector('meta[name="viewport"]');
    
    if (!metaViewport) {
      metaViewport = document.createElement('meta');
      metaViewport.setAttribute('name', 'viewport');
      document.head.appendChild(metaViewport);
    }
    
    metaViewport.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content'
    );
  }, []);

  return null;
}