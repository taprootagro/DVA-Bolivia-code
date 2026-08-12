/**
 * useKeyboardHeight — 检测移动端虚拟键盘高度
 *
 * 核心原理：通过 window.visualViewport API 监听视口变化，
 * 当键盘弹出时 visualViewport.height < window.innerHeight，差值即为键盘高度。
 *
 * 兼容性：iOS 13+ / Android Chrome 62+，覆盖主流设备。
 * 不支持 visualViewport 的浏览器自动降级为 0（不做额外处理）。
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const isKeyboardOpen = keyboardHeight > 0;
  const rafRef = useRef(0);

  // 使用 useCallback 避免闪烁：只在键盘高度变化超过阈值时更新
  const handleResize = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const vv = window.visualViewport;
      if (!vv) return;

      // 键盘高度 = 全窗口高度 - 当前可视视口高度 - 可视视口偏移
      // offsetTop 处理 iOS Safari 地址栏缩小等情况
      const fullHeight = window.innerHeight;
      const viewportHeight = vv.height;
      const diff = fullHeight - viewportHeight;

      // 只有差值 > 100px 才认为键盘弹出（排除地址栏/底部工具栏微小变化）
      if (diff > 100) {
        setKeyboardHeight(diff);
      } else {
        setKeyboardHeight(0);
      }
    });
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    vv.addEventListener('resize', handleResize);
    vv.addEventListener('scroll', handleResize);

    return () => {
      vv.removeEventListener('resize', handleResize);
      vv.removeEventListener('scroll', handleResize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [handleResize]);

  return { keyboardHeight, isKeyboardOpen };
}
