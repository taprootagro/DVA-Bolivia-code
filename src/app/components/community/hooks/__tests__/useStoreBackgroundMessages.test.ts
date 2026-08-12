import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useStoreBackgroundMessages } from "../useStoreBackgroundMessages";
import type { StorePeerRecord } from "../../../../services/storeChatDirectory";

const removeChannelMock = vi.fn();
const channelFactoryMock = vi.fn();
const ensureEdgeSessionReadyMock = vi.fn();
const touchRecentMock = vi.fn();

vi.mock("../../../../utils/supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(),
}));

vi.mock("../../../../utils/auth", () => ({
  ensureEdgeSessionReady: (...args: unknown[]) => ensureEdgeSessionReadyMock(...args),
}));

vi.mock("../../../../services/storeChatDirectory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../services/storeChatDirectory")>();
  return {
    ...actual,
    touchRecentWithPeerEnsure: (...args: unknown[]) => touchRecentMock(...args),
  };
});

import { getSupabaseBrowserClient } from "../../../../utils/supabaseBrowser";

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

describe("useStoreBackgroundMessages cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeChannelMock.mockReset();
    channelFactoryMock.mockReset();
    ensureEdgeSessionReadyMock.mockReset();
    touchRecentMock.mockReset();

    ensureEdgeSessionReadyMock.mockResolvedValue("edge-token");
    touchRecentMock.mockResolvedValue(undefined);

    channelFactoryMock.mockImplementation((name: string) => {
      const handlers: Record<string, (evt: { payload?: unknown }) => void> = {};
      const ch = {
        name,
        on: vi.fn((_type: string, _filter: unknown, handler: (evt: { payload?: unknown }) => void) => {
          handlers.message = handler;
          return ch;
        }),
        subscribe: vi.fn(),
        trigger: (payload: unknown) => handlers.message?.({ payload }),
      } as unknown as RealtimeChannel & { trigger: (payload: unknown) => void };
      return ch;
    });

    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: "session-token" } },
        }),
      },
      realtime: { setAuth: vi.fn() },
      channel: channelFactoryMock,
      removeChannel: removeChannelMock,
    } as unknown as ReturnType<typeof getSupabaseBrowserClient>);
  });

  it("removes subscribed channels when hook unmounts", async () => {
    const peers = [makePeer(), makePeer({ peerKey: "ch:channel-2", channelId: "channel-2", imUserId: "farmer-2" })];
    const { unmount } = renderHook(() =>
      useStoreBackgroundMessages("store-1", peers, null, vi.fn()),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(channelFactoryMock.mock.calls.length).toBeGreaterThan(0);
    removeChannelMock.mockClear();

    unmount();

    expect(removeChannelMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("removes all subscribed channels on dependency change", async () => {
    const peers = [makePeer(), makePeer({ peerKey: "ch:channel-2", channelId: "channel-2", imUserId: "farmer-2" })];
    const { rerender } = renderHook(
      ({ activePeerKey }) =>
        useStoreBackgroundMessages("store-1", peers, activePeerKey, vi.fn()),
      { initialProps: { activePeerKey: null as string | null } },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const subscribedCount = channelFactoryMock.mock.calls.length;
    expect(subscribedCount).toBeGreaterThan(0);
    removeChannelMock.mockClear();

    rerender({ activePeerKey: "ch:channel-1" });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(removeChannelMock).toHaveBeenCalled();
  });
});
