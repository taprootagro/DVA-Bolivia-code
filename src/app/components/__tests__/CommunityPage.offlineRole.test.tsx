import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

let capturedTargetMode: string | null = null;

vi.mock("../../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: { common: {}, community: {} }, isRTL: false }),
}));

vi.mock("../../hooks/ConfigProvider", () => ({
  useConfigContext: () => ({
    config: { communityUiMode: "store", chatContact: {} },
  }),
}));

vi.mock("../../utils/auth", () => ({
  isUserLoggedIn: () => true,
  getUserId: () => "user-farmer-1",
}));

vi.mock("../../utils/chatTabPersistence", () => ({
  readCommunityRoleCache: () => "farmer" as const,
  writeCommunityRoleCache: vi.fn(),
  clearStoreShellState: vi.fn(),
}));

vi.mock("../../utils/edgeProfileCache", () => ({
  readEdgeProfileCache: () => null,
}));

vi.mock("../community/hooks/useCommunityRoleTransition", () => ({
  useCommunityRoleTransition: (targetMode: string) => {
    capturedTargetMode = targetMode;
    return {
      displayMode: targetMode,
      transitioning: false,
      chatReady: false,
    };
  },
}));

vi.mock("../community/StoreCommunityShell", () => ({
  default: () => null,
}));

vi.mock("../../hooks/useEdgeProfile", () => ({
  useEdgeProfile: () => ({
    appRole: "farmer",
    loading: false,
    error: "Failed to fetch",
  }),
}));

import { CommunityPage } from "../CommunityPage";

describe("CommunityPage offline role fallback", () => {
  it("passes cached farmer target when profile fetch errors despite store default config", () => {
    capturedTargetMode = null;
    render(<CommunityPage />);
    expect(capturedTargetMode).toBe("farmer");
  });
});
