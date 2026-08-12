import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  setChatUnreadCount,
  useChatUnreadCount,
  setStoreChatUnreadCount,
} from "../storeChatUnread";
import {
  setActiveTab,
  useIsCommunityActive,
  getActiveTabKey,
} from "../chatTabActive";

describe("chatUnread", () => {
  it("setChatUnreadCount dispatches event consumed by hook", () => {
    const { result } = renderHook(() => useChatUnreadCount());
    expect(result.current).toBe(0);

    act(() => {
      setChatUnreadCount(3);
    });
    expect(result.current).toBe(3);

    act(() => {
      setChatUnreadCount(-1);
    });
    expect(result.current).toBe(0);
  });

  it("setStoreChatUnreadCount is alias of setChatUnreadCount", () => {
    const { result } = renderHook(() => useChatUnreadCount());
    act(() => {
      setStoreChatUnreadCount(5);
    });
    expect(result.current).toBe(5);
  });
});

vi.mock("../capacitor-bridge", () => ({
  isNative: vi.fn(() => false),
  bridge: {
    app: {
      onStateChange: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

describe("chatTabActive", () => {
  beforeEach(() => {
    setActiveTab("home");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("useIsCommunityActive is true only on community tab while visible", () => {
    const { result, rerender } = renderHook(() => useIsCommunityActive());
    expect(result.current).toBe(false);

    act(() => {
      setActiveTab("community");
    });
    rerender();
    expect(result.current).toBe(true);
    expect(getActiveTabKey()).toBe("community");
  });

  it("useIsCommunityActive is false when document hidden on web", () => {
    act(() => {
      setActiveTab("community");
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    const { result } = renderHook(() => useIsCommunityActive());
    expect(result.current).toBe(false);
  });
});
