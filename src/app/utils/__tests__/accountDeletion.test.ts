import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isDeletedSenderId,
  deletedSenderIdForUser,
  isUserAnonymizedAsDeleted,
  clearLocalAccountData,
  deleteAccount,
} from "../accountDeletion";

vi.mock("../auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth")>();
  return {
    ...actual,
    isServerAssignedId: vi.fn(),
    ensureEdgeSessionReady: vi.fn(),
    clearAuthData: vi.fn(),
    TAPROOT_AUTH_CHANGE_EVENT: "taproot-auth-change",
  };
});

vi.mock("../supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: { signOut: vi.fn().mockResolvedValue(undefined) },
  })),
  invalidateSupabaseBrowserClientCache: vi.fn(),
}));

vi.mock("../contentSuperAdminCache", () => ({
  clearContentSuperAdminCache: vi.fn(),
}));

vi.mock("../edgeProfileCache", () => ({
  clearEdgeProfileCache: vi.fn(),
}));

vi.mock("../../services/chatLocalStore", () => ({
  purgeAllChatLocalData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../safeStorage", () => ({
  storageGetJSON: vi.fn(() => ({
    backendProxyConfig: {
      enabled: true,
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      edgeFunctionName: "server",
    },
  })),
  storageRemove: vi.fn(),
}));

import { storageGetJSON } from "../safeStorage";
import { isServerAssignedId, ensureEdgeSessionReady, clearAuthData } from "../auth";

import { purgeAllChatLocalData } from "../../services/chatLocalStore";

describe("isDeletedSenderId", () => {
  it("detects deleted: prefix and deleted_user", () => {
    expect(isDeletedSenderId("deleted:abc12345")).toBe(true);
    expect(isDeletedSenderId("deleted_user")).toBe(true);
    expect(isDeletedSenderId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isDeletedSenderId("")).toBe(false);
  });
});

describe("deletedSenderIdForUser", () => {
  it("uses first 8 chars of uuid", () => {
    const uid = "550e8400-e29b-41d4-a716-446655440000";
    expect(deletedSenderIdForUser(uid)).toBe("deleted:550e8400");
  });
});

describe("isUserAnonymizedAsDeleted", () => {
  it("matches anonymized sender to original user id", () => {
    const uid = "550e8400-e29b-41d4-a716-446655440000";
    expect(isUserAnonymizedAsDeleted(uid, deletedSenderIdForUser(uid))).toBe(true);
    expect(isUserAnonymizedAsDeleted(uid, uid)).toBe(false);
  });
});

describe("deleteAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isServerAssignedId).mockReturnValue(false);
    vi.mocked(storageGetJSON).mockReturnValue(null);
  });

  it("clears local data for demo accounts without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await deleteAccount();
    expect(result).toEqual({ ok: true });
    expect(purgeAllChatLocalData).toHaveBeenCalled();
    expect(clearAuthData).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns session error when server account has no token", async () => {
    vi.mocked(isServerAssignedId).mockReturnValue(true);
    vi.mocked(storageGetJSON).mockReturnValue({
      backendProxyConfig: {
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "anon-key",
        edgeFunctionName: "server",
      },
    });
    vi.mocked(ensureEdgeSessionReady).mockResolvedValue(null);
    const result = await deleteAccount();
    expect(result).toEqual({ ok: false, error: "session_expired", status: 401 });
  });
});

describe("clearLocalAccountData", () => {
  it("purges chat cache and clears auth", async () => {
    await clearLocalAccountData();
    expect(purgeAllChatLocalData).toHaveBeenCalled();
    expect(clearAuthData).toHaveBeenCalled();
  });
});
