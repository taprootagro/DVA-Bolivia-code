import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatProxyService } from "../ChatProxyService";

const sendMessageMock = vi.fn();

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
}));

vi.mock("../IMAdapter", () => ({
  getIMAdapter: vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    sendMessage: sendMessageMock,
    getHistory: vi.fn(),
    isConnected: false,
  })),
  resetIMAdapter: vi.fn(),
  CHAT_PROVIDER_INFO: {
    supabase: { name: "Supabase", nameZh: "Supabase", features: [] },
  },
}));

describe("ChatProxyService.sendMessage server id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMock.mockReset();
  });

  it("uses server-assigned id instead of client-generated id", async () => {
    const serverId = "550e8400-e29b-41d4-a716-446655440000";
    sendMessageMock.mockResolvedValue({
      success: true,
      id: serverId,
      serverTimestamp: 1_700_000_000_000,
    });

    const service = new ChatProxyService();
    service.setUserId("user-1");

    const sent = await service.sendMessage("hello", "text", undefined, "peer-1");

    expect(sent.status).toBe("sent");
    expect(sent.id).toBe(serverId);
    expect(sent.id).not.toMatch(/^m\d+_/);
  });

  it("keeps client id when adapter does not return server id", async () => {
    sendMessageMock.mockResolvedValue({
      success: true,
      serverTimestamp: 1_700_000_000_000,
    });

    const service = new ChatProxyService();
    service.setUserId("user-1");

    const sent = await service.sendMessage("hello", "text", undefined, "peer-1");

    expect(sent.status).toBe("sent");
    expect(sent.id).toMatch(/^m\d+_/);
  });
});
