import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import type { HomePageConfig } from "../../../hooks/useHomeConfig";
import { createCmsTranslator } from "../../../i18n/cmsTranslate";
import en from "../../../i18n/lang/en";
import { patchConfigSection, type PatchSection } from "../cmsTab";

vi.mock("../../../utils/auth", () => ({
  ensureEdgeSessionReady: vi.fn(async () => "user-jwt"),
  ensureEdgeSessionReadyDetailed: vi.fn(async () => ({ token: "user-jwt", failureKind: null })),
  syncAccessTokenFromSupabaseSession: vi.fn(async () => {}),
}));

vi.mock("../../../utils/supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(() => null),
}));

import { AiModelTab } from "../AiModelTab";

const ct = createCmsTranslator(en, "en", en);

function makeConfig(backendEnabled: boolean): HomePageConfig {
  return {
    aiModelConfig: { modelUrl: "", labelsUrl: "", enableLocalModel: false },
    cloudAIConfig: {
      enabled: false,
      providerName: "",
      edgeFunctionName: "ai-vision-proxy",
      modelId: "",
      systemPrompt: "",
      maxTokens: 512,
      clientMaxConcurrent: 40,
      clientDailyLimit: 15,
      supabaseUrl: "https://cloud-only.supabase.co",
      supabaseAnonKey: "cloud-anon",
    },
    backendProxyConfig: {
      enabled: backendEnabled,
      supabaseUrl: "https://backend.supabase.co",
      supabaseAnonKey: "backend-anon",
    },
  } as unknown as HomePageConfig;
}

let latest: HomePageConfig;

function Harness({ initial }: { initial: HomePageConfig }) {
  const [cfg, setCfg] = useState(initial);
  latest = cfg;
  const patchSection: PatchSection = (key, partial) =>
    setCfg((prev) => patchConfigSection(prev, key, partial));
  return <AiModelTab workingConfig={cfg} patchSection={patchSection} ct={ct} />;
}

function toggleFor(labelText: string): HTMLButtonElement {
  return screen.getByText(labelText).parentElement!.parentElement!.querySelector("button")!;
}

describe("AiModelTab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("editing the cloud-AI anon key keeps unrelated fields such as clientMaxConcurrent", () => {
    render(<Harness initial={makeConfig(false)} />);
    fireEvent.change(screen.getByPlaceholderText("Project Settings → API → anon public"), {
      target: { value: "new-anon" },
    });
    expect(latest.cloudAIConfig.supabaseAnonKey).toBe("new-anon");
    expect(latest.cloudAIConfig.clientMaxConcurrent).toBe(40);
    expect(latest.cloudAIConfig.clientDailyLimit).toBe(15);
  });

  it("turning online AI on does not inject provider/model defaults", () => {
    render(<Harness initial={makeConfig(false)} />);
    fireEvent.click(toggleFor("Enable online (cloud) AI"));
    expect(latest.cloudAIConfig.enabled).toBe(true);
    expect(latest.cloudAIConfig.providerName).toBe("");
    expect(latest.cloudAIConfig.modelId).toBe("");
  });

  it("clearing an optional limit removes the key", () => {
    render(<Harness initial={makeConfig(false)} />);
    fireEvent.change(screen.getByPlaceholderText("15"), { target: { value: "" } });
    expect("clientDailyLimit" in latest.cloudAIConfig).toBe(false);
  });

  it("disables the cloud-only Supabase inputs when backend proxy credentials win", () => {
    render(<Harness initial={makeConfig(true)} />);
    expect(screen.getByPlaceholderText("https://xxxx.supabase.co")).toBeDisabled();
    expect(screen.getByPlaceholderText("Project Settings → API → anon public")).toBeDisabled();
    expect(screen.getByText(/Using backend proxy credentials/)).toBeInTheDocument();
  });

  it("probes <backend>/functions/v1/<fn>/health with the user JWT and shows provider/model", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "ok", provider: "qwen", modelId: "qwen-vl-max", configured: true }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness initial={makeConfig(true)} />);

    fireEvent.click(screen.getByText("Test ai-vision-proxy"));

    expect(await screen.findByText(/provider=qwen/)).toBeInTheDocument();
    expect(screen.getByText(/modelId=qwen-vl-max/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://backend.supabase.co/functions/v1/ai-vision-proxy/health");
    expect(init.headers).toEqual({ Authorization: "Bearer user-jwt", apikey: "backend-anon" });
  });
});
