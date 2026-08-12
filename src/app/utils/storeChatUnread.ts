import { useEffect, useState } from "react";

const UNREAD_EVENT = "taproot-chat-unread";

/** 聊天总未读 — 供底部 Dock 红点等跨 Tab 展示（农户 / 门店共用） */
export function setChatUnreadCount(count: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(UNREAD_EVENT, { detail: Math.max(0, Math.floor(count)) }),
  );
}

export function useChatUnreadCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      setCount(typeof n === "number" ? n : 0);
    };
    window.addEventListener(UNREAD_EVENT, onUpdate);
    return () => window.removeEventListener(UNREAD_EVENT, onUpdate);
  }, []);
  return count;
}

/** @deprecated 别名 — 门店侧可继续用旧名 */
export const setStoreChatUnreadCount = setChatUnreadCount;

/** @deprecated 别名 */
export const useStoreChatUnreadCount = useChatUnreadCount;
