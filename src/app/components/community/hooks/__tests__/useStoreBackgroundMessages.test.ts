import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStoreBackgroundMessages } from "../useStoreBackgroundMessages";
import type { StorePeerRecord } from "../../../../services/storeChatDirectory";

const subscribeChatInboxMock = vi.fn();
const touchRecentMock = vi.fn();
const cacheMessagesMock = vi.fn();
const hasLocalMessageIdMock = vi.fn();

vi.mock("../../../../services/chatInbox", () => ({
  subscribeChatInbox: (...args: unknown[]) => subscribeChatInboxMock(...args),
}));

vi.mock("../../../../services/chatLocalStore", () => ({
  cacheMessages: (...args: unknown[]) => cacheMessagesMock(...args),
  hasLocalMessageId: (...args: unknown[]) => hasLocalMessageIdMock(...args),
}));

vi.mock("../../../../services/storeChatDirectory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../services/storeChatDirectory")>();
  return {
    ...actual,
    touchRecentWithPeerEnsure: (...args: unknown[]) => touchRecentMock(...args),
  };
});

function makePeer(overrides: Partial<StorePeerRecord> = {}): StorePeerRecord {
  return {
    id: "store-1::ch:channel-1",
    storeUserId: "store-1",
    peerKey: "ch:channel-1",
    name: "Farmer",
    avatar: "",
    subtitle: "",
    imUserId: "farmer-1",
    channelId: "channel-1",
    imProvider: "supabase",
    phone: "",
    storeId: "",
    sortLetter: "F",
    updatedAt: 0,
    ...overrides,
  };
}

describe("useStoreBackgroundMessages inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribeChatInboxMock.mockImplementation((_uid: string, handler: (evt: unknown) => void) => {
      (subscribeChatInboxMock as unknown as { handler?: (evt: unknown) => void }).handler = handler;
      return vi.fn();
    });
    touchRecentMock.mockResolvedValue(undefined);
    cacheMessagesMock.mockResolvedValue(undefined);
    hasLocalMessageIdMock.mockResolvedValue(false);
  });

  it("subscribes to inbox for store user", () => {
    renderHook(() =>
      useStoreBackgroundMessages("store-1", [makePeer()], null, vi.fn()),
    );
    expect(subscribeChatInboxMock).toHaveBeenCalledWith("store-1", expect.any(Function));
  });

  it("caches message and bumps unread for new incoming", async () => {
    renderHook(() =>
      useStoreBackgroundMessages("store-1", [makePeer()], null, vi.fn()),
    );
    const handler = (subscribeChatInboxMock as unknown as { handler: (evt: unknown) => void }).handler;
    await act(async () => {
      handler({
        channelId: "channel-1",
        row: {
          id: "msg-1",
          channel_id: "channel-1",
          sender_id: "farmer-1",
          msg_type: "text",
          body: "hi",
          media_url: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
        },
        message: {
          id: "msg-1",
          channelName: "channel-1",
          senderId: "farmer-1",
          type: "text",
          content: "hi",
          timestamp: Date.now(),
          status: "sent",
          read: false,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(cacheMessagesMock).toHaveBeenCalled();
    expect(touchRecentMock).toHaveBeenCalledWith(
      "store-1",
      expect.objectContaining({ channelId: "channel-1" }),
      "hi",
      true,
    );
  });

  function incoming(id: string) {
    return {
      channelId: "channel-1",
      row: {
        id,
        channel_id: "channel-1",
        sender_id: "farmer-1",
        msg_type: "text",
        body: id,
        media_url: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
      },
      message: {
        id,
        channelName: "channel-1",
        senderId: "farmer-1",
        type: "text",
        content: id,
        timestamp: Date.now(),
        status: "sent",
        read: false,
      },
    };
  }

  it("debounces list refresh for a burst of inbox messages", async () => {
    vi.useFakeTimers();
    try {
      const onRefresh = vi.fn();
      const onIncoming = vi.fn();
      renderHook(() =>
        useStoreBackgroundMessages("store-1", [makePeer()], null, onRefresh, onIncoming),
      );
      const handler = (subscribeChatInboxMock as unknown as { handler: (evt: unknown) => void }).handler;
      await act(async () => {
        handler(incoming("m1"));
        handler(incoming("m2"));
        handler(incoming("m3"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onIncoming).toHaveBeenCalledTimes(3);
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(onRefresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending refresh on unmount", async () => {
    vi.useFakeTimers();
    try {
      const onRefresh = vi.fn();
      const { unmount } = renderHook(() =>
        useStoreBackgroundMessages("store-1", [makePeer()], null, onRefresh),
      );
      const handler = (subscribeChatInboxMock as unknown as { handler: (evt: unknown) => void }).handler;
      await act(async () => {
        handler(incoming("m1"));
        await vi.advanceTimersByTimeAsync(0);
      });
      unmount();
      await vi.advanceTimersByTimeAsync(300);
      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
