import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isSessionAccessTokenFresh,
  isRefreshTokenPermanentFailure,
  getSessionAccessTokenForEdge,
  ensureEdgeSessionReady,
  ensureEdgeSessionReadyDetailed,
  hydrateSessionFromBackup,
} from "../auth";
import { getSupabaseBrowserClient } from "../supabaseBrowser";
import { getSupabaseSessionBackupFromDexie } from "../db";
import { storageGet } from "../safeStorage";

vi.mock("../supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(),
  invalidateSupabaseBrowserClientCache: vi.fn(),
}));

vi.mock("../db", () => ({
  mirrorAuthToDexie: vi.fn().mockResolvedValue(undefined),
  mirrorSupabaseSessionToDexie: vi.fn().mockResolvedValue(undefined),
  getSupabaseSessionBackupFromDexie: vi.fn().mockResolvedValue(null),
  clearSupabaseSessionDexieBackup: vi.fn().mockResolvedValue(undefined),
  SUPABASE_AUTH_STORAGE_KEY: "taprootagro-auth",
}));

describe("isSessionAccessTokenFresh", () => {
  it("returns false when access_token is missing", () => {
    expect(isSessionAccessTokenFresh(null)).toBe(false);
    expect(isSessionAccessTokenFresh({ access_token: "" })).toBe(false);
  });

  it("returns false when token is expired", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(
      isSessionAccessTokenFresh({
        access_token: "tok",
        expires_at: nowSec - 10,
      }),
    ).toBe(false);
  });

  it("returns true when token expires beyond skew buffer", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(
      isSessionAccessTokenFresh({
        access_token: "tok",
        expires_at: nowSec + 3600,
      }),
    ).toBe(true);
  });

  it("returns true when expires_at is missing but access_token exists", () => {
    expect(isSessionAccessTokenFresh({ access_token: "tok" })).toBe(true);
  });
});

describe("isRefreshTokenPermanentFailure", () => {
  it("detects invalid_grant", () => {
    expect(isRefreshTokenPermanentFailure({ message: "invalid_grant" })).toBe(true);
    expect(isRefreshTokenPermanentFailure({ code: "invalid_grant" })).toBe(true);
  });

  it("returns false for network errors", () => {
    expect(isRefreshTokenPermanentFailure({ message: "Failed to fetch" })).toBe(false);
    expect(isRefreshTokenPermanentFailure(null)).toBe(false);
  });
});

describe("getSessionAccessTokenForEdge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fall back to stale agri_access_token when refresh fails permanently", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: "expired",
              expires_at: nowSec - 100,
              refresh_token: "rt",
            },
          },
        }),
        refreshSession: vi.fn().mockResolvedValue({
          data: { session: null },
          error: { message: "invalid_grant" },
        }),
      },
    } as never);
    vi.spyOn({ storageGet }, "storageGet").mockImplementation(() => "stale-storage-token");

    const token = await getSessionAccessTokenForEdge();
    expect(token).toBeNull();
  });

  it("returns refreshed access_token when session was near expiry", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: "expired",
              expires_at: nowSec - 5,
              refresh_token: "rt",
            },
          },
        }),
        refreshSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: "fresh-token",
              expires_at: nowSec + 3600,
              refresh_token: "rt2",
            },
          },
          error: null,
        }),
      },
    } as never);

    const token = await getSessionAccessTokenForEdge();
    expect(token).toBe("fresh-token");
  });
});

describe("ensureEdgeSessionReadyDetailed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns permanent failure when refresh_token is invalid", async () => {
    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: "expired",
              expires_at: Math.floor(Date.now() / 1000) - 100,
              refresh_token: "rt",
            },
          },
        }),
        refreshSession: vi.fn().mockResolvedValue({
          data: { session: null },
          error: { message: "invalid_grant" },
        }),
      },
    } as never);

    const result = await ensureEdgeSessionReadyDetailed();
    expect(result.token).toBeNull();
    expect(result.failureKind).toBe("permanent");
  });

  it("returns transient failure on network-style refresh errors", async () => {
    vi.useFakeTimers();
    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: "expired",
              expires_at: Math.floor(Date.now() / 1000) - 100,
              refresh_token: "rt",
            },
          },
        }),
        refreshSession: vi.fn().mockRejectedValue(new Error("Failed to fetch")),
      },
    } as never);

    const resultPromise = ensureEdgeSessionReadyDetailed();
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.token).toBeNull();
    expect(result.failureKind).toBe("transient");
    vi.useRealTimers();
  });
});

describe("ensureEdgeSessionReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no Supabase session can be refreshed", async () => {
    vi.useFakeTimers();
    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
        refreshSession: vi.fn().mockResolvedValue({
          data: { session: null },
          error: { message: "no session" },
        }),
      },
    } as never);

    const tokenPromise = ensureEdgeSessionReady();
    await vi.runAllTimersAsync();
    const token = await tokenPromise;
    expect(token).toBeNull();
    vi.useRealTimers();
  });
});

describe("hydrateSessionFromBackup", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(getSupabaseSessionBackupFromDexie).mockResolvedValue(null);
  });

  it("does not resurrect a Dexie session after logout", async () => {
    vi.mocked(getSupabaseSessionBackupFromDexie).mockResolvedValue(
      JSON.stringify({ access_token: "a", refresh_token: "r" }),
    );
    const restored = await hydrateSessionFromBackup();
    expect(restored).toBe(false);
    expect(getSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it("restores from Dexie when the user is still marked logged in", async () => {
    localStorage.setItem("isLoggedIn", "true");
    vi.mocked(getSupabaseSessionBackupFromDexie).mockResolvedValue(
      JSON.stringify({ access_token: "a", refresh_token: "r" }),
    );
    const setSession = vi.fn().mockResolvedValue({
      data: { session: { access_token: "a", user: { id: "u1" } } },
      error: null,
    });
    vi.mocked(getSupabaseBrowserClient).mockReturnValue({
      auth: { setSession },
    } as never);

    const restored = await hydrateSessionFromBackup();
    expect(restored).toBe(true);
    expect(setSession).toHaveBeenCalled();
  });
});
