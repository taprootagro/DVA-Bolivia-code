import { useEffect } from 'react';

/**
 * 响应式视口组件
 * 
 * 变更说明（v2）：
 * - 移除了动态修改根字体大小的逻辑，改为尊重用户系统字体设置
 *   （无障碍合规：WCAG 2.1 SC 1.4.4 要求文字可放大到 200% 不丢失内容）
 * - 保留 --app-height CSS 变量，解决 iOS Safari 100vh 不准的问题
 * - 用户如果在系统设置中调大字体，App 会自动跟随，无需额外处理
 */
export function ResponsiveScale() {
  useEffect(() => {
    const updateViewportHeight = () => {
      const vv = window.visualViewport;
      // 必须用 visualViewport.height：Android PWA 弹键盘时常「layout 视口」innerHeight 不变，
      // 只有视觉视口缩小；用 innerHeight 会导致整壳仍满屏 + 浏览器硬滚聚焦，输入栏被顶到顶上留白。
      const vh = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${vh}px`);
    };

    // 初始设置
    updateViewportHeight();

    window.addEventListener('resize', updateViewportHeight);

    const handleOrientation = () => {
      setTimeout(updateViewportHeight, 150);
    };
    window.addEventListener('orientationchange', handleOrientation);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', updateViewportHeight);
      vv.addEventListener('scroll', updateViewportHeight);
    }

    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', handleOrientation);
      if (vv) {
        vv.removeEventListener('resize', updateViewportHeight);
        vv.removeEventListener('scroll', updateViewportHeight);
      }
    };
  }, []);

  return null;
}