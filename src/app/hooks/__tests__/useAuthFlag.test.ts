import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const auth = vi.hoisted(() => ({ loggedIn: false }));

vi.mock("../../utils/auth", () => ({
  isUserLoggedIn: () => auth.loggedIn,
  TAPROOT_AUTH_CHANGE_EVENT: "taproot-auth-change",
}));

import { useAuthFlag } from "../useAuthFlag";

describe("useAuthFlag", () => {
  it("re-renders on login / logout events", () => {
    auth.loggedIn = false;
    const { result } = renderHook(() => useAuthFlag());
    expect(result.current).toBe(false);

    act(() => {
      auth.loggedIn = true;
      window.dispatchEvent(new Event("taproot-auth-change"));
    });
    expect(result.current).toBe(true);

    act(() => {
      auth.loggedIn = false;
      window.dispatchEvent(new Event("taproot-auth-change"));
    });
    expect(result.current).toBe(false);
  });
});
