import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthCallback } from "../OAuthCallback";

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: {
      login: {
        redirecting: "Redirecting",
        oauthError: "OAuth failed",
        supabaseAuthMissing: "Auth missing",
        oauthNotConfigured: "Not configured",
        oauthPkceVerifierHint: "PKCE hint",
        loginButton: "Log in",
      },
    },
  }),
}));

vi.mock("../../utils/capacitor-bridge", () => ({ isNative: () => true }));

vi.mock("../../utils/auth", () => ({
  setUserLoggedIn: vi.fn(),
  setServerUserId: vi.fn(),
  setAccessToken: vi.fn(),
}));

vi.mock("../../utils/supabaseBrowser", () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: mocks.getSession,
      exchangeCodeForSession: mocks.exchangeCodeForSession,
    },
  }),
  syncUserProfileFromServer: vi.fn(),
  applyOAuthMetadataToLocalProfile: vi.fn(),
  exchangeRegionalOAuthCode: vi.fn(),
}));

const session = {
  access_token: "access-token",
  user: { id: "user-1", user_metadata: {} },
};

describe("OAuthCallback", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.exchangeCodeForSession.mockResolvedValue({ data: { session }, error: null });
  });

  it("exchanges the bare auth code, not the whole callback URL", async () => {
    window.history.replaceState({}, "", "/auth/callback?code=flow-code-123&state=xyz");

    render(<OAuthCallback />);

    await waitFor(() => expect(mocks.exchangeCodeForSession).toHaveBeenCalled());
    // 传整个 URL 会让 GoTrue 报 "invalid flow state, no valid flow state found"
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("flow-code-123");
  });

  it("exchanges a new auth code even if a leftover session is still present", async () => {
    mocks.getSession.mockResolvedValue({ data: { session } });
    window.history.replaceState({}, "", "/auth/callback?code=flow-code-123");

    render(<OAuthCallback />);

    await waitFor(() => expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("flow-code-123"));
  });
});
