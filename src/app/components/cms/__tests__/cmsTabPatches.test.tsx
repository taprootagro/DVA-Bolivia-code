import { describe, it, expect } from "vitest";
import { useState, type ComponentType } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import type { HomePageConfig } from "../../../hooks/useHomeConfig";
import { createCmsTranslator } from "../../../i18n/cmsTranslate";
import en from "../../../i18n/lang/en";
import { patchConfigSection, type CmsTabProps, type PatchSection } from "../cmsTab";
import { PushProvidersTab } from "../PushProvidersTab";
import { LoginConfigTab } from "../LoginConfigTab";

const ct = createCmsTranslator(en, "en", en);

let latest: HomePageConfig;

function Harness({ Tab, initial }: { Tab: ComponentType<CmsTabProps>; initial: HomePageConfig }) {
  const [cfg, setCfg] = useState(initial);
  latest = cfg;
  const patchSection: PatchSection = (key, partial) =>
    setCfg((prev) => patchConfigSection(prev, key, partial));
  return <Tab workingConfig={cfg} patchSection={patchSection} ct={ct} />;
}

function headerToggle(text: string): HTMLButtonElement {
  return screen.getByText(text).closest("div.justify-between")!.querySelector("button")!;
}

function pushConfig(): HomePageConfig {
  return {
    banners: [{ id: 1 }],
    pushProvidersConfig: {
      activeProvider: "webpush",
      webpush: { enabled: true, vapidPublicKey: "old-vapid", pushApiBase: "https://push.example.com" },
      fcm: { enabled: false, apiKey: "AIza-keep", projectId: "proj-keep" },
    },
  } as unknown as HomePageConfig;
}

describe("PushProvidersTab patches", () => {
  it("editing the VAPID key keeps the other web push fields and provider blocks", () => {
    render(<Harness Tab={PushProvidersTab} initial={pushConfig()} />);
    fireEvent.change(screen.getByPlaceholderText("BEl62iUYgUivxIk..."), { target: { value: "new-vapid" } });
    const pc = latest.pushProvidersConfig;
    expect(pc.webpush).toEqual({ enabled: true, vapidPublicKey: "new-vapid", pushApiBase: "https://push.example.com" });
    expect(pc.fcm).toEqual({ enabled: false, apiKey: "AIza-keep", projectId: "proj-keep" });
    expect(pc.activeProvider).toBe("webpush");
    expect(latest.banners).toEqual([{ id: 1 }]);
  });

  it("activating FCM enables it without dropping its saved fields", () => {
    render(<Harness Tab={PushProvidersTab} initial={pushConfig()} />);
    fireEvent.click(headerToggle("Firebase Cloud Messaging"));
    const pc = latest.pushProvidersConfig;
    expect(pc.activeProvider).toBe("fcm");
    expect(pc.fcm).toEqual({ enabled: true, apiKey: "AIza-keep", projectId: "proj-keep" });
    expect(pc.webpush.vapidPublicKey).toBe("old-vapid");
  });

  it("typing into a provider with no saved block starts it as enabled", () => {
    const initial = pushConfig();
    (initial.pushProvidersConfig as { activeProvider: string }).activeProvider = "onesignal";
    render(<Harness Tab={PushProvidersTab} initial={initial} />);
    fireEvent.change(screen.getByPlaceholderText("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), { target: { value: "os-app" } });
    expect(latest.pushProvidersConfig.onesignal).toEqual({ enabled: true, appId: "os-app" });
  });
});

function loginConfig(): HomePageConfig {
  return {
    loginConfig: {
      socialProviders: { wechat: true, google: true, facebook: false, apple: true, alipay: true, twitter: true },
      oauthCredentials: { wechat: { appId: "wx-keep" } },
      enablePhoneLogin: true,
      enableEmailLogin: true,
      defaultLoginMethod: "phone",
    },
  } as unknown as HomePageConfig;
}

describe("LoginConfigTab patches", () => {
  it("hiding Google keeps the other providers, credentials and login methods", () => {
    render(<Harness Tab={LoginConfigTab} initial={loginConfig()} />);
    fireEvent.click(headerToggle("Google"));
    const lc = latest.loginConfig;
    expect(lc.socialProviders).toEqual({ wechat: true, google: false, facebook: false, apple: true, alipay: true, twitter: true });
    expect(lc.oauthCredentials).toEqual({ wechat: { appId: "wx-keep" } });
    expect(lc.enableEmailLogin).toBe(true);
  });

  it("turning phone login off moves the default method to email", () => {
    render(<Harness Tab={LoginConfigTab} initial={loginConfig()} />);
    fireEvent.click(headerToggle("Phone Login"));
    expect(latest.loginConfig.enablePhoneLogin).toBe(false);
    expect(latest.loginConfig.defaultLoginMethod).toBe("email");
    expect(latest.loginConfig.socialProviders.wechat).toBe(true);
  });

  it("the first toggle on a config without loginConfig seeds the defaults", () => {
    render(<Harness Tab={LoginConfigTab} initial={{} as HomePageConfig} />);
    fireEvent.click(headerToggle("Google"));
    const lc = latest.loginConfig;
    expect(lc.socialProviders.google).toBe(false);
    expect(lc.socialProviders.wechat).toBe(true);
    expect(lc.enablePhoneLogin).toBe(true);
    expect(lc.defaultLoginMethod).toBe("phone");
  });
});
