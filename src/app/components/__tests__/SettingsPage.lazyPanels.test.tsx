import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import en from "../../i18n/lang/en";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../PushNotifications", () => ({
  PushNotifications: () => <div data-testid="push-panel" />,
}));
vi.mock("../BackgroundSync", () => ({
  BackgroundSync: () => <div data-testid="sync-panel" />,
}));
vi.mock("../PermissionsSettingsPanel", () => ({
  PermissionsSettingsPanel: () => <div data-testid="permissions-panel" />,
}));
vi.mock("../AccountManagementPanel", () => ({
  AccountManagementPanel: () => <div data-testid="account-panel" />,
}));

vi.mock("../../hooks/ConfigProvider", () => ({
  useConfigContext: () => ({ config: {} }),
}));

vi.mock("../../hooks/useContentSuperAdmin", () => ({
  useContentSuperAdmin: () => ({ contentRole: null, loading: false }),
}));

vi.mock("../../utils/auth", () => ({
  isUserLoggedIn: () => true,
  isServerAssignedId: () => true,
  logoutUser: vi.fn(async () => {}),
  TAPROOT_AUTH_CHANGE_EVENT: "taproot-auth-change",
}));

import { SettingsPage } from "../SettingsPage";

describe("SettingsPage expandable panels", () => {
  it("does not mount push/sync/permissions/account panels while collapsed", () => {
    render(<SettingsPage />);
    expect(screen.queryByTestId("push-panel")).toBeNull();
    expect(screen.queryByTestId("sync-panel")).toBeNull();
    expect(screen.queryByTestId("permissions-panel")).toBeNull();
    expect(screen.queryByTestId("account-panel")).toBeNull();
  });

  it("mounts a panel only after its row is expanded, and unmounts it on collapse", () => {
    render(<SettingsPage />);
    const row = screen.getByText(en.settings.pushNotifications);

    fireEvent.click(row);
    expect(screen.getByTestId("push-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-panel")).toBeNull();

    fireEvent.click(row);
    expect(screen.queryByTestId("push-panel")).toBeNull();
  });
});
