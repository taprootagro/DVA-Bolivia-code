import { describe, it, expect } from "vitest";
import { resolvePushNavigationPath, shouldRegisterFcm } from "../useNativePushRegistration";
import type { PushProvidersConfig } from "../useHomeConfig";

function ppc(patch: Partial<PushProvidersConfig>): PushProvidersConfig {
  return {
    activeProvider: "webpush",
    webpush: { enabled: false, vapidPublicKey: "", pushApiBase: "" },
    fcm: { enabled: false, apiKey: "", projectId: "", appId: "", messagingSenderId: "", vapidKey: "" },
    ...patch,
  } as PushProvidersConfig;
}

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

describe("shouldRegisterFcm", () => {
  it("registers only when FCM is the active, enabled provider", () => {
    expect(shouldRegisterFcm(ppc({ activeProvider: "fcm", fcm: { ...ppc({}).fcm, enabled: true } }))).toBe(true);
  });

  // 未启用 FCM 却调原生 register()，会在没有 google-services.json 的包里让 App 闪退
  it("does not register when FCM is not configured", () => {
    expect(shouldRegisterFcm(undefined)).toBe(false);
    expect(shouldRegisterFcm(null)).toBe(false);
    expect(shouldRegisterFcm(ppc({}))).toBe(false);
    expect(shouldRegisterFcm(ppc({ activeProvider: "fcm" }))).toBe(false);
    expect(shouldRegisterFcm(ppc({ activeProvider: "jpush", fcm: { ...ppc({}).fcm, enabled: true } }))).toBe(false);
  });
});
