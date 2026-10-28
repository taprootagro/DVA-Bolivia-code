import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const adapterSendMock = vi.fn();

vi.mock("../../utils/safeStorage", () => ({
  storageGet: vi.fn(() =>
    JSON.stringify({
      backendProxyConfig: {
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "anon-key",
      },
    }),
  ),
}));

vi.mock("../../utils/auth", () => ({
  getUserId: vi.fn(() => "user-1"),
  getAccessToken: vi.fn(() => "user-jwt"),
  syncAccessTokenFromSupabaseSession: vi.fn(async () => {}),
}));

vi.mock("../../utils/supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(() => null),
}));

vi.mock("../IMAdapter", () => ({
  getIMAdapter: vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    sendMessage: adapterSendMock,
    getHistory: vi.fn(),
    isConnected: false,
  })),
  resetIMAdapter: vi.fn(),
  CHAT_PROVIDER_INFO: {
    supabase: { name: "Supabase", nameZh: "Supabase", features: [] },
  },
}));

import { SupabaseChatAdapter } from "../SupabaseChatAdapter";
import { ChatProxyService } from "../ChatProxyService";

describe("CHAT_RATE_LIMIT propagation", () => {
  beforeEach(() => {
    adapterSendMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("SupabaseChatAdapter.sendMessage throws CHAT_RATE_LIMIT:<s> on 429 instead of returning a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "CHAT_RATE_LIMIT", retry_after_seconds: 7 }), { status: 429 }),
      ),
    );
    const adapter = new SupabaseChatAdapter({
      imMode: "im-provider-direct",
      chatProvider: "supabase",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    } as never);

    await expect(
      adapter.sendMessage({
        id: "c1",
        content: "hi",
        type: "text",
        senderId: "user-1",
        targetUserId: "peer-1",
        channelName: "ch-1",
      }),
    ).rejects.toThrow("CHAT_RATE_LIMIT:7");
  });

  it("a rate limit on /upload/sign propagates for media and skips the legacy /upload fallback", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "CHAT_RATE_LIMIT", retry_after_seconds: 4 }), { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new SupabaseChatAdapter({
      imMode: "im-provider-direct",
      chatProvider: "supabase",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    } as never);

    await expect(
      adapter.sendMessage({
        id: "c2",
        content: "",
        type: "voice",
        senderId: "user-1",
        targetUserId: "peer-1",
        channelName: "ch-1",
        duration: 2,
        audioBlob: new Blob(["abc"], { type: "audio/webm;codecs=opus" }),
      }),
    ).rejects.toThrow("CHAT_RATE_LIMIT:4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SupabaseChatAdapter.sendMessage still returns {success:false} for other errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const adapter = new SupabaseChatAdapter({
      imMode: "im-provider-direct",
      chatProvider: "supabase",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    } as never);

    const res = await adapter.sendMessage({
      id: "c1",
      content: "hi",
      type: "text",
      senderId: "user-1",
      targetUserId: "peer-1",
      channelName: "ch-1",
    });
    expect(res).toEqual({ success: false, error: "boom" });
  });

  it("ChatProxyService rethrows rate-limit errors thrown by the adapter", async () => {
    adapterSendMock.mockRejectedValue(new Error("CHAT_RATE_LIMIT:7"));
    const service = new ChatProxyService();
    service.setUserId("user-1");
    await expect(service.sendMessage("hi", "text", undefined, "peer-1")).rejects.toThrow("CHAT_RATE_LIMIT:7");
  });

  it("ChatProxyService converts a rate-limit failure result into a thrown error", async () => {
    adapterSendMock.mockResolvedValue({ success: false, error: "CHAT_RATE_LIMIT:3" });
    const service = new ChatProxyService();
    service.setUserId("user-1");
    await expect(service.sendMessage("hi", "text", undefined, "peer-1")).rejects.toThrow("CHAT_RATE_LIMIT:3");
  });

  it("ChatProxyService keeps marking other failures as failed without throwing", async () => {
    adapterSendMock.mockResolvedValue({ success: false, error: "boom" });
    const service = new ChatProxyService();
    service.setUserId("user-1");
    const sent = await service.sendMessage("hi", "text", undefined, "peer-1");
    expect(sent.status).toBe("failed");
  });
});
