import { describe, expect, it, beforeEach } from "vitest";
import { mergeRemoteAppConfigIntoLocal } from "../ConfigSyncService";
import { CONFIG_CMS_DIRTY_KEY } from "../../constants";
import type { HomePageConfig } from "../../hooks/useHomeConfig";

function chat(overrides: Record<string, unknown> = {}) {
  return {
    merchantUserId: "local-merchant",
    channelId: "local-channel",
    name: "Local Shop",
    avatar: "",
    subtitle: "",
    verifiedDomains: ["topagro.com"],
    boundAt: 1,
    boundFrom: "topagro.com",
    ...overrides,
  };
}

function cfg(overrides: Record<string, unknown> = {}): HomePageConfig {
  return {
    chatContact: chat(),
    userProfile: { name: "me", avatar: "", phone: "", pickupAddress: "" },
    backendProxyConfig: {
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key-at-least-20-chars",
      enabled: true,
      chatProvider: "supabase",
      imMode: "im-provider-direct",
    },
    ...overrides,
  } as unknown as HomePageConfig;
}

describe("mergeRemoteAppConfigIntoLocal chatContact", () => {
  beforeEach(() => {
    localStorage.removeItem(CONFIG_CMS_DIRTY_KEY);
  });
  it("keeps a bound local merchant but takes verifiedDomains from the server", () => {
    const local = cfg();
    const remote = {
      chatContact: chat({
        merchantUserId: "remote-merchant",
        verifiedDomains: ["dva-bolivia.example"],
      }),
    };

    const merged = mergeRemoteAppConfigIntoLocal(cfg(), local, remote);

    expect(merged.chatContact.merchantUserId).toBe("local-merchant");
    expect(merged.chatContact.channelId).toBe("local-channel");
    expect(merged.chatContact.verifiedDomains).toEqual(["dva-bolivia.example"]);
  });

  it("uses the full remote chatContact when local is not bound", () => {
    const local = cfg({
      chatContact: chat({
        merchantUserId: "",
        channelId: "",
        boundAt: undefined,
        boundFrom: undefined,
        verifiedDomains: ["topagro.com"],
      }),
    });
    const remote = {
      chatContact: chat({
        merchantUserId: "",
        channelId: "",
        boundAt: undefined,
        verifiedDomains: ["farm.bo"],
      }),
    };

    const merged = mergeRemoteAppConfigIntoLocal(cfg(), local, remote);
    expect(merged.chatContact.verifiedDomains).toEqual(["farm.bo"]);
    expect(merged.chatContact.merchantUserId).toBe("");
  });
});
