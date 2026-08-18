import { describe, it, expect } from "vitest";
import { resolvePushNavigationPath } from "../useNativePushRegistration";

describe("resolvePushNavigationPath", () => {
  it("uses explicit route when provided", () => {
    expect(resolvePushNavigationPath({ route: "/home/profile" })).toBe("/home/profile");
    expect(resolvePushNavigationPath({ path: "/home/market" })).toBe("/home/market");
  });

  it("maps channel_id to community tab", () => {
    expect(resolvePushNavigationPath({ channel_id: "ch-123" })).toBe("/home/community");
    expect(resolvePushNavigationPath({ channelId: "ch-456" })).toBe("/home/community");
    expect(resolvePushNavigationPath({ route: "/home/community", channel_id: "ch-789" })).toBe("/home/community");
  });

  it("returns null when no navigable fields", () => {
    expect(resolvePushNavigationPath(null)).toBeNull();
    expect(resolvePushNavigationPath({})).toBeNull();
    expect(resolvePushNavigationPath({ msg_type: "text" })).toBeNull();
  });
});
